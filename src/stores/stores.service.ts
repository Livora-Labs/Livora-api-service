import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { CreateStoreProfileDto } from './dto/create-store-profile.dto';
import { CreateQrRedemptionDto } from './dto/create-qr-redemption.dto';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';
import { ConfirmRedemptionDto } from './dto/confirm-redemption.dto';
import { RedemptionStatus, SettlementStatus } from '@prisma/client';
import * as crypto from 'crypto';

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
    const finalAmount = redemption.tokenAmount + extraAmount;

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

    // 3. Vincular y cambiar estado a COMPLETED en una transacción de base de datos
    const updatedRedemption = await this.prisma.redemptionTransaction.update({
      where: { id: redemption.id },
      data: {
        userId: householdUserId,
        status: RedemptionStatus.COMPLETED,
        tokenAmount: finalAmount,
      },
    });

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

    if (settlement.status !== SettlementStatus.PENDING) {
      throw new ConflictException(
        `La solicitud de liquidación ya no está pendiente (Estado actual: ${settlement.status})`,
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

  async getRedemptions(userId: string) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });
    if (!storeProfile) {
      throw new NotFoundException('Perfil de tienda no encontrado');
    }
    return this.prisma.redemptionTransaction.findMany({
      where: { storeId: storeProfile.id },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { email: true } },
      },
    });
  }

  async getSettlements(userId: string) {
    const storeProfile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });
    if (!storeProfile) {
      throw new NotFoundException('Perfil de tienda no encontrado');
    }
    return this.prisma.settlementRequest.findMany({
      where: { storeId: storeProfile.id },
      orderBy: { createdAt: 'desc' },
    });
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
}
