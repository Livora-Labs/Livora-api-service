import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
  Optional,
} from '@nestjs/common';
import { RequestStatus, Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { BlockchainService } from '../../blockchain/services/blockchain.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { IpfsService } from '../../blockchain/services/ipfs.service';
import { RedisService } from '../../redis/redis.service';
import { CreateCollectionDto } from '../dto/create-collection.dto';
import { RateCollectionDto } from '../dto/rate-collection.dto';
import { EditCollectionRequestDto } from '../dto/edit-collection-request.dto';
import { UpdateCollectionStatusDto } from '../dto/update-collection-status.dto';
import { CryptoUtil } from '../../common/utils/crypto.util';
import { CollectionStateMachine } from '../states/collection-state-machine';
import { CollectionEscrowService } from './collection-escrow.service';
import { CollectionRequestBuilder } from '../builders/collection-request.builder';

/**
 * Servicio de Ciclo de Vida y Transiciones (PUCP Disoft - State Pattern & Single Responsibility)
 * Encapsula la orquestación de transiciones de estado, cancelaciones, reclasificaciones,
 * calificaciones de servicio y contingencias operativas.
 */
@Injectable()
export class CollectionLifecycleService {
  private readonly logger = new Logger(CollectionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly escrowService: CollectionEscrowService,
    private readonly blockchainService: BlockchainService,
    private readonly notificationsService: NotificationsService,
    private readonly websocketsService: WebsocketsService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly ipfsService?: IpfsService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row) return row;
    const { verificationPin, ...safe } = row;
    return safe as T;
  }

  /**
   * Actualizar el estado de una solicitud (Aceptar con Escrow o Cancelar)
   */
  async updateStatus(
    id: string,
    userId: string,
    role: string,
    dto: UpdateCollectionStatusDto,
  ) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (role === Role.RECOLECTOR) {
      if (dto.status === RequestStatus.ACCEPTED) {
        if (
          collectionRequest.status !== RequestStatus.PENDING &&
          collectionRequest.status !== RequestStatus.AUCTION_ASSIGNED
        ) {
          throw new ConflictException(
            'Esta solicitud ya no está disponible para recolección',
          );
        }

        if (!collectionRequest.assignedCenterId) {
          throw new BadRequestException(
            'La solicitud aún no tiene un Centro de Acopio asignado con tarifario.',
          );
        }

        // Validación de KYC mediante servicio especializado
        await this.escrowService.validateCollectorKyc(userId);

        // Cálculo de garantía y validación de solvencia
        const items =
          (collectionRequest.itemsEstimated as Record<string, number>) || {};
        const agreedRates =
          (collectionRequest.agreedRates as Record<string, number>) || {};
        const requiredEscrow = this.escrowService.calculateRequiredEscrow(
          items,
          agreedRates,
          collectionRequest.isDonation,
        );

        await this.escrowService.validateCollectorSolvency(userId, requiredEscrow);

        // Actualización atómica de asignación
        const updated = await this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.ACCEPTED,
            collectorId: userId,
            escrowLocked: requiredEscrow,
          },
          include: {
            household: { select: { id: true, name: true, phone: true } },
            assignedCenter: { select: { id: true, name: true, address: true } },
          },
        });

        this.notificationsService
          .sendPushNotification(
            collectionRequest.householdId,
            '¡Recolector asignado!',
            'Un recolector formal ha aceptado tu solicitud de reciclaje y se prepara para el retiro.',
            { requestId: id },
          )
          .catch(() => {});

        this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
        return this.stripPin(updated);
      }

      if (dto.status === RequestStatus.CANCELLED) {
        if (collectionRequest.collectorId !== userId) {
          throw new ForbiddenException(
            'No tienes permiso para cancelar esta solicitud',
          );
        }

        const updated = await this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.CANCELLED,
            escrowLocked: 0,
          },
        });

        this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
        return this.stripPin(updated);
      }
    }

    if (role === Role.HOGAR) {
      if (dto.status === RequestStatus.CANCELLED) {
        if (collectionRequest.householdId !== userId) {
          throw new ForbiddenException(
            'No tienes permiso para cancelar esta solicitud',
          );
        }

        if (
          collectionRequest.status !== RequestStatus.PENDING &&
          collectionRequest.status !== RequestStatus.AUCTION_ACTIVE &&
          collectionRequest.status !== RequestStatus.AUCTION_ASSIGNED
        ) {
          throw new BadRequestException(
            'No puedes cancelar una solicitud que ya fue aceptada o se encuentra en ruta',
          );
        }

        const updated = await this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.CANCELLED,
            escrowLocked: 0,
          },
        });

        this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
        return this.stripPin(updated);
      }
    }

    throw new BadRequestException('Acción no permitida para el rol actual');
  }

  /**
   * Permite a un recolector liberar/abandonar una solicitud por contingencia
   */
  async abandonCollectionRequest(
    id: string,
    collectorUserId: string,
    reason?: string,
  ) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.collectorId !== collectorUserId) {
      throw new ForbiddenException(
        'Solo el recolector asignado puede liberar o reportar abandono de esta solicitud',
      );
    }

    if (request.status !== RequestStatus.ACCEPTED) {
      throw new BadRequestException(
        `Solo solicitudes en estado ACCEPTED pueden ser abandonadas (Estado actual: ${request.status})`,
      );
    }

    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      return tx.collectionRequest.update({
        where: { id },
        data: {
          status: RequestStatus.PENDING,
          collectorId: null,
          batchId: null,
          escrowLocked: 0,
        },
        include: {
          household: { select: { id: true, email: true, name: true } },
          assignedCenter: { select: { id: true, name: true, email: true } },
          bids: true,
        },
      });
    });

    const contingencyMsg = reason
      ? `El recolector reportó una contingencia (${reason}). Tu solicitud vuelve a estar disponible para que otro recolector la tome de inmediato.`
      : 'El recolector asignado reportó una contingencia operativa. Tu solicitud vuelve a estar disponible para recolección.';

    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Solicitud de recolección reactivada',
        contingencyMsg,
        { requestId: id, ...(reason ? { reason } : {}) },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionCreated(this.stripPin(updatedRequest));
    this.websocketsService.emitCollectionUpdated(this.stripPin(updatedRequest));

    return this.stripPin(updatedRequest);
  }

  /**
   * Calificar servicio completado (1 a 5 estrellas + feedback opcional)
   */
  async rateCollectionRequest(
    householdUserId: string,
    id: string,
    dto: RateCollectionDto,
  ) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.householdId !== householdUserId) {
      throw new ForbiddenException(
        'Solo el hogar creador de la solicitud puede calificar este servicio',
      );
    }

    if (request.status !== RequestStatus.COMPLETED) {
      throw new BadRequestException(
        `Solo se pueden calificar solicitudes en estado COMPLETED (Estado actual: ${request.status})`,
      );
    }

    if (request.rating !== null && request.rating !== undefined) {
      throw new ConflictException(
        'Esta solicitud ya cuenta con una calificación registrada',
      );
    }

    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        rating: dto.rating,
        feedback: dto.feedback,
      },
    });

    let newReputation = 5.0;
    let requiresQa = false;

    if (request.collectorId) {
      const collector = await this.prisma.user.findUnique({
        where: { id: request.collectorId },
        select: {
          id: true,
          reputationScore: true,
          totalRatings: true,
          requiresQaReview: true,
        },
      });

      if (collector) {
        const currentRep = collector.reputationScore ?? 5.0;
        const currentTotal = collector.totalRatings ?? 0;
        const newTotalRatings = currentTotal + 1;
        newReputation = Number(
          (((currentRep * currentTotal) + dto.rating) / newTotalRatings).toFixed(2),
        );
        requiresQa = newReputation < 3.0 && newTotalRatings >= 5;

        await this.prisma.user.update({
          where: { id: collector.id },
          data: {
            reputationScore: newReputation,
            totalRatings: newTotalRatings,
            requiresQaReview: requiresQa ? true : collector.requiresQaReview,
          },
        });

        if (requiresQa) {
          this.logger.warn(
            `[QA_ALERT] El recolector ${collector.id} tiene reputación de ${newReputation} con ${newTotalRatings} calificaciones. Requiere revisión de QA.`,
          );
        }
      }
    }

    return {
      message: 'Calificación registrada exitosamente',
      requestId: updated.id,
      rating: updated.rating,
      feedback: updated.feedback,
      collectorReputationScore: newReputation,
      requiresQaReview: requiresQa,
    };
  }

  /**
   * Edición parcial de materiales y descripción en PENDING
   */
  async editCollectionRequest(
    householdUserId: string,
    id: string,
    dto: EditCollectionRequestDto,
  ) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.householdId !== householdUserId) {
      throw new ForbiddenException(
        'No tienes permisos para modificar esta solicitud',
      );
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException(
        'Tu solicitud ya está en curso y no puede ser modificada',
      );
    }

    const itemsToUpdate = dto.itemsEstimated
      ? JSON.stringify(dto.itemsEstimated)
      : JSON.stringify(request.itemsEstimated);
    const descToUpdate =
      dto.description !== undefined ? dto.description : request.description;

    const rowsAffected = await this.prisma.$executeRaw`
      UPDATE collection_requests
      SET "itemsEstimated" = ${itemsToUpdate}::jsonb,
          "description" = ${descToUpdate},
          "updatedAt" = NOW()
      WHERE id = ${id}::uuid 
        AND status = 'PENDING'::"RequestStatus" 
        AND "householdId" = ${householdUserId}::uuid
    `;

    if (rowsAffected === 0) {
      throw new ConflictException(
        'Tu solicitud ya está en curso y no puede ser modificada',
      );
    }

    const updated = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    this.websocketsService.emitCollectionUpdated(this.stripPin(updated!));
    return this.stripPin(updated!);
  }

  /**
   * Reporta inasistencia en domicilio (ARRIVED -> UNATTENDED)
   */
  async reportNoShow(id: string, collectorId: string) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: true,
        collector: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.collectorId !== collectorId) {
      throw new ForbiddenException(
        'Solo el recolector asignado puede reportar inasistencia',
      );
    }

    if (request.status !== RequestStatus.ARRIVED) {
      throw new BadRequestException(
        `Solo solicitudes en estado ARRIVED pueden reportarse como desatendidas (Estado actual: ${request.status})`,
      );
    }

    if (request.arrivedAt && process.env.NODE_ENV !== 'test') {
      const elapsedMs = Date.now() - new Date(request.arrivedAt).getTime();
      if (elapsedMs < 5 * 60 * 1000) {
        const remainingMin = Math.ceil((5 * 60 * 1000 - elapsedMs) / 60000);
        throw new BadRequestException(
          `Debes esperar al menos 5 minutos desde tu llegada antes de reportar inasistencia. Faltan aprox. ${remainingMin} minuto(s).`,
        );
      }
    }

    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        status: RequestStatus.UNATTENDED,
        escrowLocked: 0,
        noShowFeePen: 2.0,
      },
      include: {
        household: { select: { id: true, email: true, name: true } },
        collector: { select: { id: true, name: true, email: true } },
      },
    });

    if (request.household) {
      const currentScore = request.household.reputationScore ?? 5.0;
      const newScore = Math.max(1.0, Number((currentScore - 0.5).toFixed(2)));
      await this.prisma.user.update({
        where: { id: request.household.id },
        data: { reputationScore: newScore },
      });
    }

    // Micro-compensación de 2 ECO Tokens al recolector
    const householdUser = request.household;
    const collectorUser = request.collector;
    const encryptionKey =
      (this.configService &&
        (this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
          this.configService.get<string>('ENCRYPTION_KEY'))) ||
      (process.env.NODE_ENV === 'test'
        ? 'test_isolated_wallet_encryption_key_32c'
        : '');

    const householdVault = householdUser
      ? await this.prisma.walletVault.findUnique({
          where: { userId: householdUser.id },
        })
      : null;

    if (
      householdVault?.encryptedPrivateKey &&
      collectorUser?.walletAddress &&
      encryptionKey
    ) {
      try {
        const privKey = CryptoUtil.decrypt(
          householdVault.encryptedPrivateKey,
          encryptionKey,
        );
        await this.blockchainService.executeSubsidizedTransfer(
          privKey,
          collectorUser.walletAddress,
          2.0,
        );
      } catch (err: any) {
        this.logger.warn(
          `Micro-compensación no-show falló on-chain: ${err.message}`,
        );
      }
    }

    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Visita desatendida',
        'El recolector esperó en tu puerta y no hubo respuesta. Se aplicó una compensación de 2 ECO Tokens por traslado y penalización de reputación.',
        { requestId: id, status: 'UNATTENDED' },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
    return this.stripPin(updated);
  }

  /**
   * Rechaza material en domicilio por contaminación (ARRIVED -> REJECTED_ON_SITE)
   */
  async rejectOnSite(
    id: string,
    collectorId: string,
    reason: string,
    photoUrls?: string[],
  ) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true } },
        collector: { select: { id: true, name: true } },
      },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.collectorId !== collectorId) {
      throw new ForbiddenException(
        'Solo el recolector asignado puede reportar rechazo en sitio',
      );
    }

    if (request.status !== RequestStatus.ARRIVED) {
      throw new BadRequestException(
        `Solo solicitudes en estado ARRIVED pueden ser rechazadas en sitio (Estado actual: ${request.status})`,
      );
    }

    if (!reason || reason.trim().length < 5) {
      throw new BadRequestException(
        'Debes indicar un motivo de rechazo de al menos 5 caracteres',
      );
    }

    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        status: RequestStatus.REJECTED_ON_SITE,
        escrowLocked: 0,
        rejectionReason: reason,
        rejectionPhotos:
          photoUrls && photoUrls.length > 0 ? (photoUrls as any) : undefined,
      },
      include: {
        household: { select: { id: true, email: true, name: true } },
        collector: { select: { id: true, name: true } },
      },
    });

    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Recolección rechazada en sitio',
        `El recolector no pudo recibir los materiales: ${reason}. La orden ha sido cancelada sin penalidad.`,
        { requestId: id, status: 'REJECTED_ON_SITE', reason },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
    return this.stripPin(updated);
  }

  /**
   * Procesa fallbacks de subastas expiradas
   */
  async checkAuctionFallbacks() {
    const expired = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.AUCTION_ACTIVE,
        auctionExpiresAt: { lte: new Date() },
      },
    });

    for (const req of expired) {
      await this.prisma.collectionRequest.update({
        where: { id: req.id },
        data: {
          status: RequestStatus.PENDING,
          assignmentMode: 'AUTOMATIC',
        },
      });
      this.logger.log(`Subasta expirada ${req.id} convertida a PENDING`);
    }
  }

  /**
   * Crea una nueva solicitud de recolección (Rol HOGAR)
   * Aplica Builder Pattern y validaciones de dominio.
   */
  async create(
    userId: string,
    dto: CreateCollectionDto,
    file?:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
  ) {
    const activeRequest = await this.prisma.collectionRequest.findFirst({
      where: {
        householdId: userId,
        status: {
          in: [
            RequestStatus.PENDING,
            RequestStatus.AUCTION_ACTIVE,
            RequestStatus.AUCTION_ASSIGNED,
            RequestStatus.ACCEPTED,
            RequestStatus.EN_ROUTE,
            RequestStatus.ARRIVED,
          ],
        },
      },
    });

    if (activeRequest) {
      throw new BadRequestException(
        'El hogar ya tiene una solicitud de recolección activa. Debe completarse o cancelarse antes de crear una nueva.',
      );
    }

    const items = dto.itemsEstimated;
    if (!items || typeof items !== 'object' || Object.keys(items).length === 0) {
      throw new BadRequestException('itemsEstimated no puede estar vacío');
    }
    const totalKg = Object.values(items).reduce(
      (sum, val) => sum + (Number(val) || 0),
      0,
    );
    if (totalKg < 0.5) {
      throw new BadRequestException('El peso total mínimo de recolección es de 0.5 kg');
    }
    for (const [mat, weight] of Object.entries(items)) {
      const w = Number(weight);
      if (isNaN(w) || w < 0.5) {
        throw new BadRequestException(`El peso mínimo para ${mat} es de 0.5 kg`);
      }
      const parts = w.toString().split('.');
      if (parts.length > 1 && parts[1].length > 2) {
        throw new BadRequestException(`El peso de ${mat} no puede tener más de 2 decimales`);
      }
    }

    const verificationPin = Math.floor(1000 + Math.random() * 9000).toString();

    let photoUrl = dto.photoUrl;
    if (file) {
      const cid = await this.uploadPhoto(file, userId);
      photoUrl = this.ipfsService ? this.ipfsService.getGatewayUrl(cid) : cid;
    } else if (photoUrl && this.ipfsService) {
      photoUrl = this.ipfsService.getGatewayUrl(photoUrl);
    }

    const householdUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kycStatus: true, address: true },
    });
    const isDonation =
      (dto as any).isDonation === true ||
      householdUser?.kycStatus !== 'APPROVED';

    const effectiveAddress =
      dto.address && dto.address.trim().length > 0
        ? dto.address.trim()
        : (householdUser?.address || 'Ubicación seleccionada');

    const assignmentMode = dto.assignmentMode === 'AUCTION' ? 'AUCTION' : 'AUTOMATIC';
    const status =
      assignmentMode === 'AUCTION'
        ? RequestStatus.AUCTION_ACTIVE
        : RequestStatus.PENDING;
    const auctionExpiresAt =
      assignmentMode === 'AUCTION'
        ? new Date(Date.now() + 15 * 60 * 1000)
        : null;

    const builder = new CollectionRequestBuilder()
      .setHousehold(userId)
      .setCoordinates(dto.latitude, dto.longitude)
      .setItems(items)
      .setAddress(effectiveAddress)
      .setVerificationPin(verificationPin)
      .setIsDonation(isDonation)
      .setAssignmentMode(assignmentMode as any);

    if (photoUrl) builder.setPhotoUrl(photoUrl);
    if (dto.description) builder.setDescription(dto.description);

    const newRequest = await this.prisma.collectionRequest.create({
      data: {
        status,
        assignmentMode,
        itemsEstimated: dto.itemsEstimated,
        description: dto.description,
        verificationPin,
        address: effectiveAddress,
        latitude: dto.latitude,
        longitude: dto.longitude,
        photoUrl,
        householdId: userId,
        auctionExpiresAt,
        isDonation,
      },
      include: {
        household: {
          select: { id: true, email: true, name: true },
        },
        assignedCenter: {
          select: { id: true, name: true, email: true },
        },
        bids: {
          include: {
            center: { select: { id: true, name: true, email: true, address: true } },
          },
        },
      },
    });

    if (this.redisService) {
      await this.redisService.set(
        `pin:collection:${newRequest.id}`,
        verificationPin,
        1800,
      );
    }

    this.websocketsService.emitCollectionCreated(this.stripPin(newRequest));

    this.prisma.user
      .findMany({
        where: {
          role: Role.CENTRO_ACOPIO,
          fcmToken: { not: null },
        },
        select: { id: true },
      })
      .then((centers) => {
        for (const c of centers) {
          this.notificationsService
            .sendPushNotification(
              c.id,
              assignmentMode === 'AUCTION'
                ? 'Nueva subasta de reciclaje disponible'
                : 'Nueva solicitud de recolección automática',
              'Ingresa para postular tu tarifario o tomar la solicitud.',
              { requestId: newRequest.id },
            )
            .catch(() => {});
        }
      })
      .catch(() => {});

    return newRequest;
  }

  private async uploadPhoto(
    file:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
    userId: string,
  ): Promise<string> {
    if (!this.ipfsService) {
      return `mock_cid_${Date.now()}`;
    }
    try {
      return await this.ipfsService.uploadFile(file);
    } catch (error: any) {
      this.logger.error(`Error al subir foto a IPFS: ${error.message}`);
      throw new BadRequestException('No se pudo procesar la foto en IPFS');
    }
  }
}
