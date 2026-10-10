import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletsService } from '../../wallets/wallets.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { RedemptionStatus } from '@prisma/client';
import { CreateQrRedemptionDto } from '../dto/create-qr-redemption.dto';
import { ConfirmRedemptionDto } from '../dto/confirm-redemption.dto';
import { PaginatedResultDto } from '../../common/dto/paginated-result.dto';
import * as crypto from 'crypto';

@Injectable()
export class StoreRedemptionsService {
  private readonly logger = new Logger(StoreRedemptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
    private readonly websocketsService: WebsocketsService,
    private readonly notificationsService: NotificationsService,
    @InjectQueue('blockchain-queue')
    private readonly blockchainQueue: Queue,
  ) {}

  /**
   * Genera un código QR para un canje (Rol: TIENDA).
   */
  async generateQrRedemption(
    storeProfileId: string,
    dto: CreateQrRedemptionDto,
  ) {
    const finalAmount = dto.tokenAmount;
    if (!finalAmount || finalAmount <= 0) {
      throw new BadRequestException('El monto debe ser un número positivo');
    }

    const qrCodeRef = `LIVORA-QR-${crypto.randomUUID()}`;

    const transaction = await this.prisma.redemptionTransaction.create({
      data: {
        storeId: storeProfileId,
        tokenAmount: finalAmount,
        qrCodeRef,
        status: RedemptionStatus.PENDING,
      },
    });

    return {
      qrCodeRef: transaction.qrCodeRef,
      tokenAmount: transaction.tokenAmount,
      status: transaction.status,
    };
  }

  /**
   * Escanea y confirma un canje (Rol: HOGAR).
   * Valida saldo de tokens on-chain del usuario hogar, vincula el userId, marca COMPLETED,
   * notifica a la tienda vía WebSockets y encola la transferencia on-chain.
   */
  async confirmRedemption(
    householdUserId: string,
    qrCodeRef: string,
    dto: ConfirmRedemptionDto,
  ) {
    if (!dto || dto.termsAccepted !== true) {
      throw new BadRequestException(
        'Debe aceptar los Términos y Condiciones de Uso para completar el pago.',
      );
    }

    const redemption = await this.prisma.redemptionTransaction.findUnique({
      where: { qrCodeRef },
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

    if (!redemption) {
      throw new NotFoundException('Transacción de canje no encontrada');
    }

    if (redemption.status !== RedemptionStatus.PENDING) {
      throw new ConflictException(
        `El canje ya no está pendiente (Estado actual: ${redemption.status})`,
      );
    }

    let extraAmount = 0;
    if (dto.donationOptIn === true) {
      extraAmount += 1.0;
    }
    if (dto.insuranceOptIn === true) {
      extraAmount += 0.5;
    }
    const finalAmount = Number(redemption.tokenAmount) + extraAmount;

    const userWallet = await this.prisma.user.findUnique({
      where: { id: householdUserId },
      select: { walletAddress: true },
    });

    if (!userWallet?.walletAddress) {
      throw new BadRequestException(
        'El usuario hogar no tiene una billetera configurada',
      );
    }

    const updatedRedemption = await this.prisma.$transaction(
      async (tx) => {
        const lockedUsers = await tx.$queryRaw<
          Array<{ id: string; walletAddress: string | null }>
        >`
          SELECT id, "walletAddress" 
          FROM users 
          WHERE id = ${householdUserId}::uuid 
          FOR UPDATE
        `;

        if (!lockedUsers || lockedUsers.length === 0) {
          throw new NotFoundException('Usuario hogar no encontrado en el sistema');
        }

        const lockedUser = lockedUsers[0];
        if (!lockedUser.walletAddress) {
          throw new BadRequestException(
            'El usuario hogar no tiene una billetera configurada',
          );
        }

        const lockedRedemptions = await tx.$queryRaw<
          Array<{ id: string; status: string; tokenAmount: string }>
        >`
          SELECT id, status, "tokenAmount"
          FROM redemption_transactions
          WHERE id = ${redemption.id}::uuid AND status = 'PENDING'
          FOR UPDATE
        `;

        if (!lockedRedemptions || lockedRedemptions.length === 0) {
          throw new ConflictException(
            'Canje procesado previamente o ya no está disponible',
          );
        }

        const balanceResult = await this.walletsService.getBalance(householdUserId);
        const balance = parseFloat(balanceResult.balance || '0');

        if (balance < finalAmount) {
          throw new BadRequestException(
            `Saldo de LIVOs insuficiente para realizar el canje. Requerido: ${finalAmount}, Disponible: ${balance}`,
          );
        }

        const result = await tx.$executeRaw`
          UPDATE redemption_transactions 
          SET status = 'COMPLETED', "userId" = ${householdUserId}::uuid, "tokenAmount" = ${finalAmount}::numeric, "updatedAt" = NOW()
          WHERE id = ${redemption.id}::uuid AND status = 'PENDING'
        `;

        if (result === 0) {
          throw new ConflictException(
            'Canje procesado previamente o ya no está disponible',
          );
        }

        try {
          const accounts = await tx.$queryRaw<
            Array<{ id: string; cachedBalance: string }>
          >`
            SELECT id, "cachedBalance" 
            FROM accounts 
            WHERE "userId" = ${householdUserId}::uuid AND "accountType" = 'USER_WALLET'
            FOR UPDATE
          `;

          if (accounts && accounts.length > 0) {
            const acc = accounts[0];
            const newBalance = Math.max(
              0,
              parseFloat(acc.cachedBalance) - finalAmount,
            );
            await tx.$executeRaw`
              UPDATE accounts 
              SET "cachedBalance" = ${newBalance}::numeric, "updatedAt" = NOW()
              WHERE id = ${acc.id}::uuid
            `;
          }
        } catch {
          // Continuar si la tabla accounts no existe
        }

        return (await tx.redemptionTransaction.findUnique({
          where: { id: redemption.id },
        }))!;
      },
      {
        timeout: 10000,
        isolationLevel: 'ReadCommitted',
      },
    );

    const storeUserId = redemption.store.user.id;
    this.websocketsService.emitStoreNotification(
      storeUserId,
      'redemption:completed',
      {
        redemptionId: updatedRedemption.id,
        tokenAmount: updatedRedemption.tokenAmount,
        status: updatedRedemption.status,
        householdId: householdUserId,
        qrCodeRef: updatedRedemption.qrCodeRef,
      },
    );

    await this.blockchainQueue.add(
      'redemption-transfer',
      {
        redemptionId: updatedRedemption.id,
        fromUserId: householdUserId,
        toStoreUserId: storeUserId,
        fromWallet: userWallet.walletAddress,
        toWallet: redemption.store.user.walletAddress,
        tokenAmount: updatedRedemption.tokenAmount,
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    return updatedRedemption;
  }

  /**
   * Anulación y reversión de canje de EcoTokens en punto de venta.
   */
  async refundRedemption(storeUserId: string, redemptionId: string) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId: storeUserId },
      include: {
        user: { select: { id: true, walletAddress: true } },
      },
    });

    if (!storeProfile) {
      throw new NotFoundException('Perfil de tienda no encontrado para este usuario');
    }

    const redemption = await this.prisma.redemptionTransaction.findUnique({
      where: { id: redemptionId },
      include: {
        user: { select: { id: true, walletAddress: true } },
      },
    });

    if (!redemption) {
      throw new NotFoundException('Transacción de canje no encontrada');
    }

    if (redemption.storeId !== storeProfile.id) {
      throw new ForbiddenException('Esta transacción no corresponde a tu tienda');
    }

    if (redemption.status !== (RedemptionStatus.COMPLETED as any)) {
      throw new BadRequestException(
        `Solo transacciones en estado COMPLETED pueden ser anuladas (Estado actual: ${redemption.status})`,
      );
    }

    const now = new Date();
    const createdAt = new Date(redemption.createdAt);
    const diffHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (diffHours > 24) {
      throw new BadRequestException(
        `El plazo máximo de 24 horas para anular el canje ha expirado (Han transcurrido ${diffHours.toFixed(1)} horas)`,
      );
    }

    const refundAmount = Number(redemption.tokenAmount);
    const storeBalanceResult = await this.walletsService.getBalance(storeUserId);
    const storeBalance = parseFloat(storeBalanceResult.balance || '0');

    if (storeBalance < refundAmount) {
      throw new BadRequestException(
        `Saldo insuficiente de LIVOs en la tienda para revertir el canje. Requerido: ${refundAmount} LIVO, Saldo disponible: ${storeBalance} LIVO.`,
      );
    }

    const updatedRedemption = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.redemptionTransaction.update({
        where: { id: redemptionId },
        data: {
          status: 'REFUNDED' as any,
          updatedAt: new Date(),
        },
      });
      return updated;
    });

    if (
      redemption.userId &&
      redemption.user?.walletAddress &&
      storeProfile.user?.walletAddress
    ) {
      await this.blockchainQueue.add(
        'redemption-refund-transfer',
        {
          redemptionId: updatedRedemption.id,
          fromStoreUserId: storeUserId,
          toHouseholdUserId: redemption.userId,
          fromWallet: storeProfile.user.walletAddress,
          toWallet: redemption.user.walletAddress,
          tokenAmount: updatedRedemption.tokenAmount,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }

    this.websocketsService.emitStoreNotification(
      storeUserId,
      'redemption:refunded',
      {
        redemptionId: updatedRedemption.id,
        tokenAmount: updatedRedemption.tokenAmount,
        status: updatedRedemption.status,
      },
    );

    if (redemption.userId) {
      this.notificationsService
        ?.sendPushNotification(
          redemption.userId,
          'Canje anulado y reembolsado',
          `Tu canje por ${redemption.tokenAmount} LIVOs en ${storeProfile.businessName} ha sido anulado. Los LIVOs han sido devueltos a tu saldo.`,
          { redemptionId: updatedRedemption.id, status: 'REFUNDED' },
        )
        .catch(() => {});
    }

    return updatedRedemption;
  }

  /**
   * Tarea para expirar transacciones de canje (QR) pendientes (>24h).
   */
  async handleExpirePendingRedemptions() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.prisma.redemptionTransaction.updateMany({
      where: {
        status: RedemptionStatus.PENDING,
        createdAt: {
          lt: twentyFourHoursAgo,
        },
      },
      data: {
        status: RedemptionStatus.EXPIRED,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `[CRON REDEMPTIONS] Se marcaron ${result.count} códigos QR pendientes como EXPIRED (>24h).`,
      );
    }
  }

  /**
   * Obtener historial de canjes de una tienda con paginación.
   */
  async getRedemptions(storeProfileId: string, page = 1, limit = 15) {
    const where = { storeId: storeProfileId };
    const skip = (page - 1) * limit;

    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, redemptions] = await Promise.all([
      readPrisma.redemptionTransaction.count({ where }),
      readPrisma.redemptionTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { email: true } },
        },
      }),
    ]);

    return new PaginatedResultDto(redemptions, total, page, limit);
  }

  /**
   * Obtiene los detalles de un código QR pendiente.
   */
  async getRedemptionDetails(qrCodeRef: string) {
    const redemption = await this.prisma.redemptionTransaction.findUnique({
      where: { qrCodeRef },
      include: {
        store: {
          select: {
            businessName: true,
          },
        },
      },
    });

    if (!redemption) {
      throw new NotFoundException('Cobro no encontrado o inválido');
    }

    if (redemption.status !== RedemptionStatus.PENDING) {
      throw new BadRequestException('El cobro ya ha sido procesado o pagado');
    }

    return {
      qrCodeRef: redemption.qrCodeRef,
      tokenAmount: redemption.tokenAmount,
      businessName: redemption.store.businessName,
      status: redemption.status,
    };
  }
}
