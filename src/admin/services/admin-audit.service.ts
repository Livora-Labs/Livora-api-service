import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BLOCKCHAIN_QUEUE,
  BLOCKCHAIN_DLQ,
} from '../../blockchain/blockchain.constants';
import { StellarRpcManagerService } from '../../blockchain/services/stellar-rpc-manager.service';
import { AuditLogBufferService } from '../../common/services/audit-log-buffer.service';
import {
  LedgerAuditQueryDto,
  ServerLogsQueryDto,
} from '../dto/audit-query.dto';

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
    @Optional()
    @InjectQueue(BLOCKCHAIN_DLQ)
    private readonly blockchainDlq?: Queue,
    @Optional()
    private readonly stellarRpcManager?: StellarRpcManagerService,
    @Optional()
    private readonly auditLogBuffer?: AuditLogBufferService,
  ) {}

  /**
   * Obtiene la salud real, latencia en ms y bloque ledger activo del cluster Stellar RPC.
   * Cero mocks: interroga en tiempo real a los nodos configurados (QuickNode / Soroban).
   */
  async getBlockchainHealth() {
    if (this.stellarRpcManager) {
      return this.stellarRpcManager.getRealHealthAndLatency();
    }

    return {
      status: 'unknown',
      network: 'Stellar Testnet',
      latency: 'N/A',
      blockNumber: 0,
      activeNodeUrl: 'N/A',
      timestamp: new Date().toISOString(),
      nodes: [],
    };
  }

  /**
   * Auditoría y Reconciliación de Partida Doble (Zero Loss Assurance).
   * Compara matemáticamente el saldo en Account.cachedBalance contra
   * sum(CREDIT - DEBIT) en ledger_entries para detectar fugas o desajustes de saldo.
   */
  async getFinancialReconciliation() {
    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const accounts = await readPrisma.account.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            walletAddress: true,
          },
        },
        ledgerEntries: {
          select: {
            entryType: true,
            amount: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let totalCirculatingTokens = 0;
    let totalTreasuryTokens = 0;
    let totalCredits = 0;
    let totalDebits = 0;

    const discrepancies: Array<{
      accountId: string;
      userId: string | null;
      userEmail: string | null;
      accountType: string;
      cachedBalance: number;
      calculatedLedgerBalance: number;
      variance: number;
    }> = [];

    for (const account of accounts) {
      const cached = Number(account.cachedBalance);

      if (account.accountType === 'USER_WALLET') {
        totalCirculatingTokens += cached;
      } else {
        totalTreasuryTokens += cached;
      }

      let accountCredits = 0;
      let accountDebits = 0;

      for (const entry of account.ledgerEntries) {
        const amt = Number(entry.amount);
        if (entry.entryType === 'CREDIT') {
          accountCredits += amt;
          totalCredits += amt;
        } else {
          accountDebits += amt;
          totalDebits += amt;
        }
      }

      const calculated = accountCredits - accountDebits;
      const variance = Math.abs(cached - calculated);

      // Tolerancia micrométrica para redondeos de punto flotante en BD
      if (variance > 0.0000001) {
        discrepancies.push({
          accountId: account.id,
          userId: account.userId,
          userEmail: account.user?.email || null,
          accountType: account.accountType,
          cachedBalance: cached,
          calculatedLedgerBalance: calculated,
          variance: Number(variance.toFixed(7)),
        });
      }
    }

    const totalRedemptions = await readPrisma.redemptionTransaction.count();
    const completedRedemptions = await readPrisma.redemptionTransaction.count({
      where: { status: 'COMPLETED' },
    });

    return {
      timestamp: new Date().toISOString(),
      isReconciled: discrepancies.length === 0,
      summary: {
        totalAccountsAudited: accounts.length,
        totalCirculatingTokens: Number(totalCirculatingTokens.toFixed(7)),
        totalTreasuryTokens: Number(totalTreasuryTokens.toFixed(7)),
        totalCredits: Number(totalCredits.toFixed(7)),
        totalDebits: Number(totalDebits.toFixed(7)),
        netLedgerBalance: Number((totalCredits - totalDebits).toFixed(7)),
        totalRedemptions,
        completedRedemptions,
      },
      discrepanciesCount: discrepancies.length,
      discrepancies,
    };
  }

  /**
   * Consulta paginada y filtrada de asientos contables en el Libro Mayor (LedgerEntry).
   * Permite rastrear asientos por Correlation ID, Hash Stellar o búsqueda de texto.
   */
  async getLedgerAudit(query: LedgerAuditQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const where: any = {};

    if (query.correlationId) {
      where.correlationId = query.correlationId;
    }

    if (query.txHash) {
      where.txHash = { contains: query.txHash, mode: 'insensitive' };
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.OR = [
        { description: { contains: term, mode: 'insensitive' } },
        { txHash: { contains: term, mode: 'insensitive' } },
        {
          account: {
            user: {
              email: { contains: term, mode: 'insensitive' },
            },
          },
        },
      ];
    }

    const [items, total] = await Promise.all([
      readPrisma.ledgerEntry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: {
              id: true,
              accountType: true,
              cachedBalance: true,
              user: {
                select: {
                  id: true,
                  email: true,
                  role: true,
                  walletAddress: true,
                },
              },
            },
          },
        },
      }),
      readPrisma.ledgerEntry.count({ where }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Auditoría de colas de procesamiento asíncrono (BullMQ) y eventos Outbox.
   */
  async getQueueAudit() {
    let queueStats = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      dlqCount: 0,
    };

    const failedJobs: Array<{
      id: string | undefined;
      name: string;
      data: any;
      failedReason: string | undefined;
      timestamp: number | undefined;
      queue: string;
    }> = [];

    if (this.blockchainQueue) {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.blockchainQueue.getWaitingCount(),
        this.blockchainQueue.getActiveCount(),
        this.blockchainQueue.getCompletedCount(),
        this.blockchainQueue.getFailedCount(),
        this.blockchainQueue.getDelayedCount(),
      ]);

      queueStats = {
        ...queueStats,
        waiting,
        active,
        completed,
        failed,
        delayed,
      };

      const rawFailed = await this.blockchainQueue.getFailed(0, 15);
      failedJobs.push(
        ...rawFailed.map((j) => ({
          id: j.id,
          name: j.name,
          data: j.data,
          failedReason: j.failedReason,
          timestamp: j.timestamp,
          queue: BLOCKCHAIN_QUEUE,
        })),
      );
    }

    if (this.blockchainDlq) {
      const dlqCount = await this.blockchainDlq.getWaitingCount();
      queueStats.dlqCount = dlqCount;

      const rawDlqJobs = await this.blockchainDlq.getJobs(
        ['waiting', 'active', 'failed'],
        0,
        15,
      );
      failedJobs.push(
        ...rawDlqJobs.map((j) => ({
          id: j.id,
          name: j.name,
          data: j.data,
          failedReason: j.failedReason,
          timestamp: j.timestamp,
          queue: BLOCKCHAIN_DLQ,
        })),
      );
    }

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [pendingOutboxCount, failedOutboxCount, outboxEvents] =
      await Promise.all([
        readPrisma.outboxEvent.count({ where: { status: 'PENDING' } }),
        readPrisma.outboxEvent.count({ where: { status: 'FAILED' } }),
        readPrisma.outboxEvent.findMany({
          where: { status: { in: ['FAILED', 'PENDING'] } },
          take: 15,
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    const pendingPayments = await readPrisma.paymentTransaction.findMany({
      where: {
        status: 'COMPLETED',
        blockchainStatus: { in: ['PENDING', 'FAILED_BLOCKCHAIN'] },
      },
      take: 15,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            email: true,
            walletAddress: true,
          },
        },
      },
    });

    return {
      timestamp: new Date().toISOString(),
      queueStats,
      failedJobs,
      outboxStats: {
        pending: pendingOutboxCount,
        failed: failedOutboxCount,
        recentEvents: outboxEvents,
      },
      pendingPayments,
    };
  }

  /**
   * Reintenta manualmente un trabajo de la cola BullMQ o lo promociona de la DLQ.
   */
  async retryQueueJob(jobId: string) {
    if (this.blockchainQueue) {
      const job = await this.blockchainQueue.getJob(jobId);
      if (job) {
        await job.retry();
        this.logger.log(
          `[AdminAudit] Trabajo ${jobId} reintentado en BLOCKCHAIN_QUEUE`,
        );
        return {
          status: 'SUCCESS',
          message: `Trabajo ${jobId} re-encolado para ejecución inmediata`,
          queue: BLOCKCHAIN_QUEUE,
        };
      }
    }

    if (this.blockchainDlq) {
      const dlqJob = await this.blockchainDlq.getJob(jobId);
      if (dlqJob && this.blockchainQueue) {
        await this.blockchainQueue.add(dlqJob.name, dlqJob.data, {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        });
        await dlqJob.remove();
        this.logger.log(
          `[AdminAudit] Trabajo DLQ ${jobId} promocionado a BLOCKCHAIN_QUEUE`,
        );
        return {
          status: 'SUCCESS',
          message: `Trabajo ${jobId} restaurado desde DLQ a la cola primaria`,
          queue: BLOCKCHAIN_QUEUE,
        };
      }
    }

    throw new NotFoundException(
      `Trabajo ${jobId} no encontrado en las colas de ejecución`,
    );
  }

  /**
   * Restablece un evento Outbox fallido a estado PENDING para que el cron/worker lo reprocese.
   */
  async retryOutboxEvent(eventId: string) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento Outbox no encontrado');
    }

    const updated = await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'PENDING',
        retryCount: 0,
        errorMessage: null,
      },
    });

    this.logger.log(
      `[AdminAudit] Evento Outbox ${eventId} restablecido a PENDING`,
    );

    return {
      status: 'SUCCESS',
      message: 'Evento Outbox restablecido a PENDING para reprocesamiento',
      event: updated,
    };
  }

  /**
   * Consulta el buffer circular de logs operativos del servidor.
   */
  async getServerLogs(query: ServerLogsQueryDto) {
    if (!this.auditLogBuffer) {
      return {
        total: 0,
        limit: 50,
        skip: 0,
        items: [],
        stats: { totalBuffered: 0, errors: 0, warnings: 0, info: 0 },
      };
    }

    return this.auditLogBuffer.query({
      level: query.level,
      correlationId: query.correlationId,
      search: query.search,
      limit: query.limit,
      skip: query.skip,
    });
  }

  async retryPaymentMint(paymentIdentifier: string) {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        OR: [{ id: paymentIdentifier }, { purchaseNumber: paymentIdentifier }],
      },
      include: { user: true },
    });

    if (!payment) {
      throw new NotFoundException('Transacción de pago no encontrada');
    }

    if (payment.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Solo se puede reintentar el minteo de pagos confirmados fiduciariamente (COMPLETED)',
      );
    }

    if (payment.blockchainStatus === 'MINTED') {
      return {
        message: 'Los tokens ya fueron minteados exitosamente en la blockchain',
        txHash: payment.txHash,
      };
    }

    if (!payment.user.walletAddress) {
      throw new BadRequestException(
        'El usuario no posee una billetera Stellar configurada',
      );
    }

    if (this.blockchainQueue) {
      const job = await this.blockchainQueue.add(
        'izipay-mint-tokens',
        {
          userId: payment.userId,
          walletAddress: payment.user.walletAddress,
          amount: Number(payment.tokenAmount),
          purchaseNumber: payment.purchaseNumber,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      await this.prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: { blockchainStatus: 'PENDING' },
      });

      return {
        status: 'QUEUED',
        jobId: job.id,
        purchaseNumber: payment.purchaseNumber,
        tokenAmount: payment.tokenAmount,
        walletAddress: payment.user.walletAddress,
        message:
          'Trabajo de minteo re-encolado en Stellar Soroban exitosamente',
      };
    }

    return {
      status: 'ERROR',
      message: 'Cola de blockchain no disponible en el servidor',
    };
  }
}
