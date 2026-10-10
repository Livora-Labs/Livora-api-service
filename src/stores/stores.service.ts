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
import { RoutingService } from '../routing/routing.service';
import { CreateStoreProfileDto } from './dto/create-store-profile.dto';
import { CreateQrRedemptionDto } from './dto/create-qr-redemption.dto';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';
import { ConfirmRedemptionDto } from './dto/confirm-redemption.dto';
import { UpdateSettlementStatusDto } from './dto/update-settlement-status.dto';
import { RedemptionStatus, SettlementStatus, Role } from '@prisma/client';
import * as crypto from 'crypto';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';

import { StoreRedemptionsService } from './services/store-redemptions.service';
import { StoreSettlementsService } from './services/store-settlements.service';

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);
  private readonly redemptionsService: StoreRedemptionsService;
  private readonly settlementsService: StoreSettlementsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
    private readonly websocketsService: WebsocketsService,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly routingService?: RoutingService,
    @Optional() redemptionsService?: StoreRedemptionsService,
    @Optional() settlementsService?: StoreSettlementsService,
  ) {
    this.redemptionsService =
      redemptionsService ||
      new StoreRedemptionsService(
        prisma,
        walletsService,
        websocketsService,
        notificationsService || ({} as any),
        blockchainQueue,
      );
    this.settlementsService =
      settlementsService ||
      new StoreSettlementsService(
        prisma,
        walletsService,
        websocketsService,
        configService,
        blockchainQueue,
      );
  }

  /**
   * Resuelve coordenadas geográficas para una dirección física.
   */
  private async resolveCoordinates(
    address?: string,
    explicitLat?: number,
    explicitLng?: number,
  ): Promise<{ lat?: number; lng?: number }> {
    if (
      explicitLat != null &&
      explicitLng != null &&
      Number(explicitLat) !== 0 &&
      Number(explicitLng) !== 0
    ) {
      return { lat: Number(explicitLat), lng: Number(explicitLng) };
    }
    if (!address || !address.trim() || !this.routingService) {
      return {};
    }
    try {
      const geoResults = await this.routingService.searchAddress(address.trim());
      if (geoResults && geoResults.length > 0) {
        return { lat: geoResults[0].latitude, lng: geoResults[0].longitude };
      }
    } catch (err: any) {
      this.logger.warn(
        `No se pudo geocodificar la dirección "${address}": ${err.message}`,
      );
    }
    return {};
  }

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

    // Resolver coordenadas geográficas (explícitas o a través de geocodificación de address)
    const coords = await this.resolveCoordinates(
      dto.address,
      dto.latitude,
      dto.longitude,
    );

    // Actualizar coordenadas y datos en la tabla User
    await this.prisma.user
      .update({
        where: { id: userId },
        data: {
          name: dto.businessName ?? undefined,
          address: dto.address ?? undefined,
          ...(coords.lat != null && coords.lng != null
            ? { latitude: coords.lat, longitude: coords.lng }
            : {}),
        },
      })
      .catch((err) => {
        this.logger.warn(`Error al actualizar usuario para tienda ${userId}: ${err.message}`);
      });

    return this.prisma.storeProfile.create({
      data: {
        userId,
        businessName: dto.businessName,
        ruc: dto.ruc,
        address: dto.address,
        bankAccount: dto.bankAccount ?? '',
        logoUrl: dto.logoUrl,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            walletAddress: true,
            latitude: true,
            longitude: true,
          },
        },
      },
    });
  }

  /**
   * Obtiene de forma idempotente el perfil de tienda para un usuario.
   * Si el usuario tiene rol TIENDA y aún no cuenta con perfil (ej. cuentas previas a la migración),
   * inicializa el perfil base de manera automática para garantizar cero errores 404 en el cliente.
   */
  async getOrCreateStoreProfile(userId: string) {
    let profile = await this.prisma.storeProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (user && user.role === Role.TIENDA) {
        profile = await this.prisma.storeProfile.create({
          data: {
            userId,
            businessName: user.name || user.email.split('@')[0],
            ruc: '',
            address: '',
            bankAccount: '',
          },
        });
      }
    }

    return profile;
  }

  /**
   * POST /stores/redemptions/qr
   * Genera un código QR para un canje (Rol: TIENDA).
   */
  async generateQrRedemption(userId: string, dto: CreateQrRedemptionDto) {
    const storeProfile = await this.getOrCreateStoreProfile(userId);
    if (!storeProfile) {
      throw new NotFoundException(
        'Perfil de tienda no encontrado para este usuario',
      );
    }
    return this.redemptionsService.generateQrRedemption(storeProfile.id, dto);
  }

  /**
   * POST /stores/redemptions/confirm/:qrCodeRef
   * Escanea y confirma un canje (Rol: HOGAR).
   */
  async confirmRedemption(
    householdUserId: string,
    qrCodeRef: string,
    dto: ConfirmRedemptionDto,
  ) {
    return this.redemptionsService.confirmRedemption(
      householdUserId,
      qrCodeRef,
      dto,
    );
  }

  /**
   * POST /stores/redemptions/:id/refund (Rol: TIENDA)
   * Anulación y reversión de canje de EcoTokens en punto de venta.
   */
  async refundRedemption(storeUserId: string, redemptionId: string) {
    return this.redemptionsService.refundRedemption(
      storeUserId,
      redemptionId,
    );
  }

  /**
   * POST /stores/settlements
   * Solicita una liquidación (Rol: TIENDA).
   */
  async requestSettlement(userId: string, dto: CreateSettlementRequestDto) {
    const storeProfile = await this.getOrCreateStoreProfile(userId);
    return this.settlementsService.requestSettlement(
      userId,
      storeProfile,
      dto,
    );
  }

  /**
   * PATCH /stores/settlements/:id/pay
   * Procesa y aprueba el pago de una liquidación (Rol: ADMIN).
   */
  async paySettlement(settlementId: string, dto: PaySettlementDto) {
    return this.settlementsService.paySettlement(settlementId, dto);
  }

  /**
   * Actualiza el estado de una liquidación según su máquina de estados (Rol: ADMIN).
   */
  async updateSettlementStatus(
    settlementId: string,
    dto: UpdateSettlementStatusDto,
  ) {
    return this.settlementsService.updateSettlementStatus(settlementId, dto);
  }

  /**
   * Tarea para expirar transacciones de canje (QR) pendientes (>24h).
   */
  async handleExpirePendingRedemptions() {
    return this.redemptionsService.handleExpirePendingRedemptions();
  }

  /**
   * Obtiene el perfil de tienda de un usuario (Rol: TIENDA)
   */
  async getProfile(userId: string) {
    const profile = await this.getOrCreateStoreProfile(userId);
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

    const coords = await this.resolveCoordinates(
      dto.address,
      dto.latitude,
      dto.longitude,
    );

    if (!profile) {
      await this.prisma.user
        .update({
          where: { id: userId },
          data: {
            name: dto.businessName ?? undefined,
            address: dto.address ?? undefined,
            ...(coords.lat != null && coords.lng != null
              ? { latitude: coords.lat, longitude: coords.lng }
              : {}),
          },
        })
        .catch(() => {});

      return this.prisma.storeProfile.create({
        data: {
          userId,
          businessName: dto.businessName,
          ruc: dto.ruc,
          address: dto.address,
          bankAccount: dto.bankAccount ?? '',
          logoUrl: dto.logoUrl,
        },
      });
    }

    await this.prisma.user
      .update({
        where: { id: userId },
        data: {
          name: dto.businessName ?? undefined,
          address: dto.address ?? undefined,
          ...(coords.lat != null && coords.lng != null
            ? { latitude: coords.lat, longitude: coords.lng }
            : {}),
        },
      })
      .catch(() => {});

    return this.prisma.storeProfile.update({
      where: { id: profile.id },
      data: {
        businessName: dto.businessName,
        ruc: dto.ruc,
        address: dto.address,
        bankAccount: dto.bankAccount ?? profile.bankAccount,
        logoUrl: dto.logoUrl,
      },
    });
  }

  async getRedemptions(userId: string, page = 1, limit = 15) {
    const storeProfile = await this.getOrCreateStoreProfile(userId);
    if (!storeProfile) {
      return new PaginatedResultDto([], 0, page, limit);
    }
    return this.redemptionsService.getRedemptions(storeProfile.id, page, limit);
  }

  async getSettlements(userId: string, page = 1, limit = 15) {
    const storeProfile = await this.getOrCreateStoreProfile(userId);
    if (!storeProfile) {
      return new PaginatedResultDto([], 0, page, limit);
    }
    return this.settlementsService.getSettlements(storeProfile.id, page, limit);
  }

  async getAllSettlements(page = 1, limit = 15, status?: SettlementStatus) {
    return this.settlementsService.getAllSettlements(page, limit, status);
  }

  async getRedemptionDetails(qrCodeRef: string) {
    return this.redemptionsService.getRedemptionDetails(qrCodeRef);
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
        role: Role.TIENDA,
        isActive: true,
        kycStatus: 'APPROVED',
      },
      include: {
        storeProfile: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      stores.map(async (u, index) => {
        const sp = u.storeProfile;
        const candidateStoreName = sp?.businessName?.trim();
        const candidateUserName = u.name?.trim();
        const emailPrefix = u.email ? u.email.split('@')[0] : '';

        // Si el businessName es solo el prefijo del email pero el usuario tiene un nombre real (o viceversa),
        // elegir el nombre más representativo y nunca un string provisional o vacío.
        let name = 'Comercio Aliado';
        if (candidateStoreName && candidateStoreName !== emailPrefix) {
          name = candidateStoreName;
        } else if (candidateUserName && candidateUserName !== emailPrefix) {
          name = candidateUserName;
        } else if (candidateStoreName) {
          name = candidateStoreName;
        } else if (candidateUserName) {
          name = candidateUserName;
        }

        const address = sp?.address || u.address || 'Lima, Perú';

        let lat = u.latitude;
        let lng = u.longitude;

        // Si la tienda aún no tiene coordenadas en users, intentar resolverlas dinámicamente y guardarlas
        if ((lat == null || lng == null) && address && this.routingService) {
          try {
            const resolved = await this.resolveCoordinates(address);
            if (resolved.lat != null && resolved.lng != null) {
              lat = resolved.lat;
              lng = resolved.lng;
              // Guardar asíncronamente en BD para evitar futuras búsquedas
              this.prisma.user
                .update({
                  where: { id: u.id },
                  data: { latitude: lat, longitude: lng },
                })
                .catch(() => {});
            }
          } catch {}
        }

        // Si todavía es null por alguna dirección irreconocible, dispersar ligeramente para evitar agrupación en un solo punto
        const finalLat =
          lat ?? Number((-12.1215 + (index * 0.007)).toFixed(6));
        const finalLng =
          lng ?? Number((-77.0298 + (index * 0.007)).toFixed(6));

        return {
          id: sp?.id || u.id,
          userId: u.id,
          name,
          businessName: sp?.businessName || u.name || name,
          category: 'BioFerias & Orgánicos',
          address,
          latitude: finalLat,
          longitude: finalLng,
          phone: u.phone || '+51 956789012',
          email: u.email,
          discount: 'Canje 1 LIVO = S/ 1.00 PEN',
          description:
            'Comercio eco-amigable aliado al ecosistema Livora para canje de LIVOs.',
          walletAddress: u.walletAddress,
          logoUrl: sp?.logoUrl,
          ruc: sp?.ruc,
        };
      }),
    );
  }
}
