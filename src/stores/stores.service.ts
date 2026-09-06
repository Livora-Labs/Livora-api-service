import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateStoreProfileDto } from './dto/create-store-profile.dto';
import { CreateQrRedemptionDto } from './dto/create-qr-redemption.dto';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';
import { ConfirmRedemptionDto } from './dto/confirm-redemption.dto';
import { UpdateSettlementStatusDto } from './dto/update-settlement-status.dto';
import { RedemptionStatus, SettlementStatus, Role } from '@prisma/client';
import * as crypto from 'crypto';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
    private readonly websocketsService: WebsocketsService,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  /**
   * POST /stores/profile
   * Crea el perfil de una tienda para el usuario autenticado (Rol: TIENDA).
   */
  async createProfile(userId: string, dto: CreateStoreProfileDto) {
    // Verificar si el usuario ya tiene un perfil de tienda
    const existingProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });

    if (existingProfile) {
      throw new ConflictException(
        'El usuario ya tiene un perfil de tienda registrado',
      );
    }

    return this.prisma.storeProfile.create({
      data: {
        userId,
        businessName: dto.businessName,
        ruc: dto.ruc,
        address: dto.address,
        bankAccount: dto.bankAccount,
        logoUrl: dto.logoUrl,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            walletAddress: true,
          },
        },
      },
    });
  }

  /**
   * POST /stores/redemptions/qr
   * Genera un código QR para un canje (Rol: TIENDA).
   * Registra la transacción en estado PENDING y sin userId.
   */
  async generateQrRedemption(userId: string, dto: CreateQrRedemptionDto) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });

    if (!storeProfile) {
      throw new NotFoundException(
        'Perfil de tienda no encontrado para este usuario',
      );
    }

    const finalAmount = dto.tokenAmount;
    if (!finalAmount || finalAmount <= 0) {
      throw new BadRequestException('El monto debe ser un número positivo');
    }

    // Generar un qrCodeRef único (UUID v4 + prefijo para legibilidad)
    const qrCodeRef = `LIVORA-QR-${crypto.randomUUID()}`;

    const transaction = await this.prisma.redemptionTransaction.create({
      data: {
        storeId: storeProfile.id,
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
   * POST /stores/redemptions/confirm/:qrCodeRef
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

    // 1. Buscar la transacción de canje
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

    // Calcular cargos adicionales
    let extraAmount = 0;
    if (dto.donationOptIn === true) {
      extraAmount += 1.0;
    }
    if (dto.insuranceOptIn === true) {
      extraAmount += 0.5;
    }
    const finalAmount = Number(redemption.tokenAmount) + extraAmount;

    // 2. Verificar el saldo del Hogar
    const userWallet = await this.prisma.user.findUnique({
      where: { id: householdUserId },
      select: { walletAddress: true },
    });

    if (!userWallet?.walletAddress) {
      throw new BadRequestException(
        'El usuario hogar no tiene una billetera configurada',
      );
    }

    // Consulta rápida al balance de tokens
    const balanceResult = await this.walletsService.getBalance(householdUserId);
    const balance = parseFloat(balanceResult.balance || '0');

    if (balance < finalAmount) {
      throw new BadRequestException(
        `Saldo de EcoTokens insuficiente para realizar el canje. Requerido: ${finalAmount}, Disponible: ${balance}`,
      );
    }

    // 3. Vincular y cambiar estado a COMPLETED de forma atómica y condicional
    const result = await this.prisma.$executeRaw`
      UPDATE redemption_transactions 
      SET status = 'COMPLETED', "userId" = ${householdUserId}::uuid, "tokenAmount" = ${finalAmount}::numeric, "updatedAt" = NOW()
      WHERE id = ${redemption.id}::uuid AND status = 'PENDING'
    `;

    if (result === 0) {
      throw new ConflictException('Canje procesado previamente o ya no está disponible');
    }

    const updatedRedemption = (await this.prisma.redemptionTransaction.findUnique({
      where: { id: redemption.id },
    }))!;

    // 4. Disparar notificación WebSocket a la sala privada de la tienda store:${storeUserId}
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

    // 5. Encolar trabajo en BullMQ (blockchain-queue)
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
   * POST /stores/redemptions/:id/refund (Rol: TIENDA)
   * Anulación y reversión de canje de EcoTokens en punto de venta.
   * Valida:
   * 1. Que el canje pertenezca a la tienda y esté en COMPLETED.
   * 2. Que no exceda 24 horas desde createdAt (si excede, HTTP 400).
   * 3. Guardia anti-doble gasto: Que el saldo libre de EcoTokens de la tienda >= monto del reembolso.
   * 4. Transacción atómica en PostgreSQL cambiando a REFUNDED.
   * 5. Encolado asíncrono en BullMQ ('redemption-refund-transfer') para restitución on-chain (Tienda -> Hogar).
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

    // Validación de 24 horas
    const now = new Date();
    const createdAt = new Date(redemption.createdAt);
    const diffHours = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (diffHours > 24) {
      throw new BadRequestException(
        `El plazo máximo de 24 horas para anular el canje ha expirado (Han transcurrido ${diffHours.toFixed(1)} horas)`,
      );
    }

    // Guardia anti-doble gasto: verificar saldo disponible en tokens de la tienda
    const refundAmount = Number(redemption.tokenAmount);
    const storeBalanceResult = await this.walletsService.getBalance(storeUserId);
    const storeBalance = parseFloat(storeBalanceResult.balance || '0');

    if (storeBalance < refundAmount) {
      throw new BadRequestException(
        `Saldo insuficiente de EcoTokens en la tienda para revertir el canje. Requerido: ${refundAmount} ECO, Saldo disponible: ${storeBalance} ECO.`,
      );
    }

    // Transacción atómica en base de datos
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

    // Encolar trabajo de transferencia on-chain (Tienda -> Hogar) en BullMQ
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

    // Notificaciones WebSocket y Push
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
          '↩️ Canje anulado y reembolsado',
          `Tu canje por ${redemption.tokenAmount} EcoTokens en ${storeProfile.businessName} ha sido anulado. Los tokens han sido devueltos a tu saldo.`,
          { redemptionId: updatedRedemption.id, status: 'REFUNDED' },
        )
        .catch(() => {});
    }

    return updatedRedemption;
  }

  /**
   * POST /stores/settlements
   * Solicita una liquidación (Rol: TIENDA).
   * Calcula el fiatAmount (1 Token = 1 Sol) y registra en PENDING.
   */
  async requestSettlement(userId: string, dto: CreateSettlementRequestDto) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });

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

    // 1. Validar saldo disponible de EcoTokens para evitar sobregiro o liquidaciones sin respaldo
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
        `Saldo insuficiente de EcoTokens. Solicitas liquidar ${dto.tokenAmount} ECO, pero tu saldo disponible es de ${availableBalance.toFixed(2)} ECO (Saldo total: ${totalBalance.toFixed(2)} ECO, Retenido en liquidación previa: ${alreadyPendingAmount.toFixed(2)} ECO).`,
      );
    }

    // Calcular el monto en Soles (fiatAmount) con tasa de cambio 1:1
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
   * PATCH /stores/settlements/:id/pay
   * Procesa y aprueba el pago de una liquidación (Rol: ADMIN).
   * Cambia el estado a PAID, registra el comprobante, notifica a la tienda por WS
   * y encola la transferencia de tokens desde la tienda a la wallet de tesorería.
   */
  async paySettlement(settlementId: string, dto: PaySettlementDto) {
    // 1. Buscar la solicitud de liquidación
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

    // 2. Actualizar estado a PAID y añadir receiptUrl
    const updatedSettlement = await this.prisma.settlementRequest.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.PAID,
        receiptUrl: dto.receiptUrl,
      },
    });

    // 3. Notificar a la tienda vía WebSockets: settlement:paid
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

    // 4. Encolar transferencia de tokens de la wallet de la tienda a la tesorería de Livora
    // Usamos el walletAddress de la tienda como origen, y la wallet del Relayer/Master como tesorería de fallback
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
   * PENDING -> APPROVED_PENDING_PAYMENT | REJECTED | PAID
   * APPROVED_PENDING_PAYMENT -> PAID | REJECTED
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
   * Tarea para expirar transacciones de canje (QR) pendientes
   * que tengan más de 24 horas de antigüedad (invocada desde RedemptionExpirationWorker).
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
   * Obtiene el perfil de tienda de un usuario (Rol: TIENDA)
   */
  async getProfile(userId: string) {
    const profile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new NotFoundException(
        'Perfil de tienda no encontrado para este usuario',
      );
    }
    return profile;
  }

  /**
   * Crea o actualiza el perfil de tienda
   */
  async updateProfile(userId: string, dto: CreateStoreProfileDto) {
    const profile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      return this.prisma.storeProfile.create({
        data: {
          userId,
          businessName: dto.businessName,
          ruc: dto.ruc,
          address: dto.address,
          bankAccount: dto.bankAccount,
          logoUrl: dto.logoUrl,
        },
      });
    }

    return this.prisma.storeProfile.update({
      where: { id: profile.id },
      data: {
        businessName: dto.businessName,
        ruc: dto.ruc,
        address: dto.address,
        bankAccount: dto.bankAccount,
        logoUrl: dto.logoUrl,
      },
    });
  }

  async getRedemptions(userId: string, page = 1, limit = 15) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });
    if (!storeProfile) {
      throw new NotFoundException('Perfil de tienda no encontrado');
    }
    const where = { storeId: storeProfile.id };
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

  async getSettlements(userId: string, page = 1, limit = 15) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });
    if (!storeProfile) {
      throw new NotFoundException('Perfil de tienda no encontrado');
    }
    const where = { storeId: storeProfile.id };
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

  /**
   * GET /stores/allied
   * Retorna el catálogo de comercios y tiendas aliadas reales registradas en el sistema.
   */
  async getAlliedStores() {
    const readPrisma =
      (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const stores = await readPrisma.user.findMany({
      where: {
        role: { in: [Role.TIENDA, Role.ALMACEN] },
        isActive: true,
      },
      include: {
        storeProfile: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return stores.map((u) => {
      const sp = u.storeProfile;
      const name = sp?.businessName || u.name || 'Comercio Aliado';
      return {
        id: sp?.id || u.id,
        userId: u.id,
        name,
        businessName: sp?.businessName || u.name || name,
        category: 'BioFerias & Orgánicos',
        address: sp?.address || u.address || 'Lima, Perú',
        latitude: u.latitude || -12.1215,
        longitude: u.longitude || -77.0298,
        phone: u.phone || '+51 956789012',
        email: u.email,
        discount: 'Canje 1 ECO = S/ 1.00 PEN',
        description:
          'Comercio eco-amigable aliado al ecosistema Livora para canje de EcoTokens.',
        walletAddress: u.walletAddress,
        logoUrl: sp?.logoUrl,
        ruc: sp?.ruc,
      };
    });
  }
}
