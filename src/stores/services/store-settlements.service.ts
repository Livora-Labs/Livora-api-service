import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletsService } from '../../wallets/wallets.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { SettlementStatus } from '@prisma/client';
import { CreateSettlementRequestDto } from '../dto/create-settlement-request.dto';
import { PaySettlementDto } from '../dto/pay-settlement.dto';
import { UpdateSettlementStatusDto } from '../dto/update-settlement-status.dto';
import { PaginatedResultDto } from '../../common/dto/paginated-result.dto';

@Injectable()
export class StoreSettlementsService {
  private readonly logger = new Logger(StoreSettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
    private readonly websocketsService: WebsocketsService,
    private readonly configService: ConfigService,
    @InjectQueue('blockchain-queue')
    private readonly blockchainQueue: Queue,
  ) {}

  /**
   * Solicita una liquidación (Rol: TIENDA).
   * Calcula el fiatAmount (1 Token = 1 Sol) y registra en PENDING.
   */
  async requestSettlement(
    userId: string,
    storeProfile: any,
    dto: CreateSettlementRequestDto,
  ) {
    if (!storeProfile) {
      throw new NotFoundException(
        'Perfil de tienda no encontrado para este usuario',
      );
    }

    if (dto.cci) {
      const cleanCci = dto.cci.replace(/[\s-]/g, '');
      if (cleanCci.length !== 20 || !/^\d{20}$/.test(cleanCci)) {
        throw new BadRequestException('El CCI bancario debe contener exactamente 20 dígitos numéricos');
      }
      if (cleanCci !== storeProfile.bankAccount) {
        await this.prisma.storeProfile.update({
          where: { id: storeProfile.id },
          data: { bankAccount: cleanCci },
        });
      }
    }

    // Validar saldo disponible de EcoTokens
    const balanceObj = await this.walletsService.getBalance(userId);
    const totalBalance = parseFloat(balanceObj.balance) || 0;

    const activePending = await this.prisma.settlementRequest.aggregate({
      where: {
        storeId: storeProfile.id,
        status: SettlementStatus.PENDING,
      },
      _sum: { tokenAmount: true },
    });
    const alreadyPendingAmount = Number(activePending._sum.tokenAmount || 0);
    const availableBalance = Math.max(0, totalBalance - alreadyPendingAmount);

    if (availableBalance < dto.tokenAmount) {
      throw new BadRequestException(
        `Saldo insuficiente de LIVOs. Solicitas liquidar ${dto.tokenAmount} LIVO, pero tu saldo disponible es de ${availableBalance.toFixed(2)} LIVO (Saldo total: ${totalBalance.toFixed(2)} LIVO, Retenido en liquidación previa: ${alreadyPendingAmount.toFixed(2)} LIVO).`,
      );
    }

    const fiatAmount = dto.tokenAmount;

    return this.prisma.settlementRequest.create({
      data: {
        storeId: storeProfile.id,
        tokenAmount: dto.tokenAmount,
        fiatAmount,
        status: SettlementStatus.PENDING,
      },
    });
  }

  /**
   * Procesa y aprueba el pago de una liquidación (Rol: ADMIN).
   * Cambia el estado a PAID, registra el comprobante, notifica a la tienda por WS
   * y encola la transferencia de tokens desde la tienda a la wallet de tesorería.
   */
  async paySettlement(settlementId: string, dto: PaySettlementDto) {
    const settlement = await this.prisma.settlementRequest.findUnique({
      where: { id: settlementId },
      include: {
        store: {
          include: {
            user: {
              select: {
                id: true,
                walletAddress: true,
              },
            },
          },
        },
      },
    });

    if (!settlement) {
      throw new NotFoundException('Solicitud de liquidación no encontrada');
    }

    if (
      settlement.status !== SettlementStatus.PENDING &&
      settlement.status !== SettlementStatus.APPROVED_PENDING_PAYMENT
    ) {
      throw new ConflictException(
        `La solicitud de liquidación ya no está pendiente de pago (Estado actual: ${settlement.status})`,
      );
    }

    const updatedSettlement = await this.prisma.settlementRequest.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.PAID,
        receiptUrl: dto.receiptUrl,
      },
    });

    const storeUserId = settlement.store.user.id;
    this.websocketsService.emitStoreNotification(
      storeUserId,
      'settlement:paid',
      {
        settlementId: updatedSettlement.id,
        tokenAmount: updatedSettlement.tokenAmount,
        fiatAmount: updatedSettlement.fiatAmount,
        status: updatedSettlement.status,
        receiptUrl: updatedSettlement.receiptUrl,
      },
    );

    const treasuryWallet =
      this.configService.get<string>('ECOTOKEN_CONTRACT_ID') ||
      'CD7L2OEZL74GPHXQ32EEXI7Y7DPHF74GPHXQ32EEXI7Y7DPHF74GPHXQ';

    await this.blockchainQueue.add(
      'settlement-transfer',
      {
        settlementId: updatedSettlement.id,
        fromStoreUserId: storeUserId,
        fromWallet: settlement.store.user.walletAddress,
        toWallet: treasuryWallet,
        tokenAmount: updatedSettlement.tokenAmount,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    return updatedSettlement;
  }

  /**
   * Actualiza el estado de una liquidación según su máquina de estados (Rol: ADMIN).
   */
  async updateSettlementStatus(
    settlementId: string,
    dto: UpdateSettlementStatusDto,
  ) {
    const settlement = await this.prisma.settlementRequest.findUnique({
      where: { id: settlementId },
      include: {
        store: {
          include: {
            user: {
              select: {
                id: true,
                walletAddress: true,
              },
            },
          },
        },
      },
    });

    if (!settlement) {
      throw new NotFoundException('Solicitud de liquidación no encontrada');
    }

    const storeUserId = settlement.store.user.id;

    if (dto.status === SettlementStatus.APPROVED_PENDING_PAYMENT) {
      if (settlement.status !== SettlementStatus.PENDING) {
        throw new ConflictException(
          `Solo solicitudes en PENDING pueden pasar a APPROVED_PENDING_PAYMENT (Estado actual: ${settlement.status})`,
        );
      }
      const updated = await this.prisma.settlementRequest.update({
        where: { id: settlementId },
        data: { status: SettlementStatus.APPROVED_PENDING_PAYMENT },
      });
      this.websocketsService.emitStoreNotification(
        storeUserId,
        'settlement:approved',
        {
          settlementId: updated.id,
          tokenAmount: updated.tokenAmount,
          fiatAmount: updated.fiatAmount,
          status: updated.status,
        },
      );
      return updated;
    }

    if (dto.status === SettlementStatus.PAID) {
      if (!dto.receiptUrl) {
        throw new BadRequestException(
          'receiptUrl es obligatorio para marcar la liquidación como PAID',
        );
      }
      return this.paySettlement(settlementId, { receiptUrl: dto.receiptUrl });
    }

    if (dto.status === SettlementStatus.REJECTED) {
      if (
        settlement.status !== SettlementStatus.PENDING &&
        settlement.status !== SettlementStatus.APPROVED_PENDING_PAYMENT
      ) {
        throw new ConflictException(
          `Solo solicitudes en PENDING o APPROVED_PENDING_PAYMENT pueden ser rechazadas (Estado actual: ${settlement.status})`,
        );
      }
      const updated = await this.prisma.settlementRequest.update({
        where: { id: settlementId },
        data: {
          status: SettlementStatus.REJECTED,
        },
      });
      this.websocketsService.emitStoreNotification(
        storeUserId,
        'settlement:rejected',
        {
          settlementId: updated.id,
          tokenAmount: updated.tokenAmount,
          fiatAmount: updated.fiatAmount,
          status: updated.status,
          rejectionReason:
            dto.rejectionReason || 'Rechazada por administración',
        },
      );
      return updated;
    }

    throw new BadRequestException(
      `Transición hacia el estado ${dto.status} no permitida`,
    );
  }

  /**
   * Listar liquidaciones de una tienda específica.
   */
  async getSettlements(storeProfileId: string, page = 1, limit = 15) {
    const where = { storeId: storeProfileId };
    const skip = (page - 1) * limit;

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, settlements] = await Promise.all([
      readPrisma.settlementRequest.count({ where }),
      readPrisma.settlementRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return new PaginatedResultDto(settlements, total, page, limit);
  }

  /**
   * Listar todas las liquidaciones del sistema (Rol: ADMIN).
   */
  async getAllSettlements(page = 1, limit = 15, status?: SettlementStatus) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) {
      where.status = status;
    }
    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, settlements] = await Promise.all([
      readPrisma.settlementRequest.count({ where }),
      readPrisma.settlementRequest.findMany({
        where,
        include: {
          store: {
            select: {
              id: true,
              businessName: true,
              ruc: true,
              address: true,
              bankAccount: true,
              user: {
                select: {
                  email: true,
                  name: true,
                  walletAddress: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return new PaginatedResultDto(settlements, total, page, limit);
  }
}
