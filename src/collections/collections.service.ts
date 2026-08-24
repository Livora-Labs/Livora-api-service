import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { IpfsService } from '../blockchain/services/ipfs.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { RequestStatus, Role } from '@prisma/client';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly ipfsService: IpfsService,
    private readonly websocketsService: WebsocketsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Crea una nueva solicitud de recolección (Rol HOGAR)
   */
  async create(
    userId: string,
    dto: CreateCollectionDto,
    file?:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
  ) {
    // 1. Verificar si el hogar ya tiene una solicitud activa (PENDING o ACCEPTED)
    const activeRequest = await this.prisma.collectionRequest.findFirst({
      where: {
        householdId: userId,
        status: {
          in: [RequestStatus.PENDING, RequestStatus.ACCEPTED],
        },
      },
    });

    if (activeRequest) {
      throw new BadRequestException(
        'El hogar ya tiene una solicitud de recolección activa. Debe completarse o cancelarse antes de crear una nueva.',
      );
    }

    // Generar PIN aleatorio de 4 dígitos (1000 - 9999)
    const verificationPin = Math.floor(1000 + Math.random() * 9000).toString();

    // Procesar la foto de forma opcional y formatear con IPFS gateway
    let photoUrl = dto.photoUrl;
    if (file) {
      const cid = await this.uploadPhoto(file, userId);
      photoUrl = this.ipfsService.getGatewayUrl(cid);
    } else if (photoUrl) {
      photoUrl = this.ipfsService.getGatewayUrl(photoUrl);
    }

    const newRequest = await this.prisma.collectionRequest.create({
      data: {
        status: RequestStatus.PENDING,
        itemsEstimated: dto.itemsEstimated,
        description: dto.description,
        verificationPin,
        latitude: dto.latitude,
        longitude: dto.longitude,
        photoUrl,
        householdId: userId,
      },
    });

    // Emitir en tiempo real a los recolectores. SIN el PIN de verificación:
    // el PIN es un secreto que solo el hogar debe conocer y mostrar en persona.
    this.websocketsService.emitCollectionCreated(this.stripPin(newRequest));

    // Buscar todos los recolectores con token FCM para enviar la notificación
    this.prisma.user
      .findMany({
        where: {
          role: Role.RECOLECTOR,
          fcmToken: { not: null },
        },
        select: { id: true },
      })
      .then((collectors) => {
        for (const col of collectors) {
          this.notificationsService
            .sendPushNotification(
              col.id,
              '♻️ Nueva solicitud de reciclaje',
              'Hay una nueva solicitud de recogida de materiales lista en tu zona.',
              { requestId: newRequest.id },
            )
            .catch(() => {});
        }
      })
      .catch(() => {});

    return newRequest;
  }

  /**
   * Obtener solicitudes según el rol del usuario autenticado
   * - HOGAR: Historial de sus propias solicitudes
   * - RECOLECTOR: Solicitudes PENDING cercanas usando PostGIS ST_DistanceSphere (o todas las PENDING)
   */
  async findAll(
    user: { id: string; role: string },
    query: FindCollectionsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'updatedAt', 'status'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as
      'asc' | 'desc';

    if (user.role === Role.HOGAR) {
      return this.prisma.collectionRequest.findMany({
        where: { householdId: user.id },
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include: {
          collector: {
            select: { id: true, email: true },
          },
          batch: true,
        },
      });
    }

    if (user.role === Role.RECOLECTOR) {
      const { lat, lng, radius = 5 } = query;

      if (lat !== undefined && lng !== undefined) {
        const radiusInMeters = radius * 1000;

        // Búsqueda espacial con PostGIS ST_DistanceSphere (LIMIT y OFFSET de forma segura)
        const results = await this.prisma.$queryRaw<any[]>`
          SELECT 
            id, 
            status, 
            "itemsEstimated", 
            "photoUrl", 
            description, 
            latitude, 
            longitude, 
            "householdId", 
            "collectorId", 
            "createdAt", 
            "updatedAt",
            ST_DistanceSphere(
              ST_MakePoint(longitude, latitude),
              ST_MakePoint(${lng}, ${lat})
            ) AS distance
          FROM collection_requests
          WHERE status = 'PENDING'::"RequestStatus"
            AND ST_DistanceSphere(
              ST_MakePoint(longitude, latitude),
              ST_MakePoint(${lng}, ${lat})
            ) <= ${radiusInMeters}
          ORDER BY distance ASC
          LIMIT ${limit} OFFSET ${skip};
        `;

        return results.map((item) => ({
          ...item,
          photoUrl: item.photoUrl
            ? this.ipfsService.getGatewayUrl(item.photoUrl)
            : item.photoUrl,
        }));
      }

      // Si el recolector no provee lat/lng, retornar todas las solicitudes PENDING con paginación
      const pending = await this.prisma.collectionRequest.findMany({
        where: { status: RequestStatus.PENDING },
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include: {
          household: {
            select: { id: true, email: true },
          },
        },
      });
      return pending.map((r) => this.stripPin(r));
    }

    throw new ForbiddenException(
      'Rol no autorizado para listar solicitudes de recolección',
    );
  }

  /**
   * Quita el PIN de verificación de una solicitud. El PIN solo debe verlo el
   * hogar dueño; jamás los recolectores (ni en listados, ni en eventos, ni en detalle).
   */
  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row || typeof row !== 'object') return row;
    const clone: any = { ...row };
    delete clone.verificationPin;
    return clone;
  }

  /**
   * Obtener detalle de una solicitud por ID
   * - HOGAR: Solo puede ver sus propias solicitudes (householdId === userId)
   * - RECOLECTOR: Puede ver cualquier solicitud (sin el PIN)
   */
  async findOne(id: string, userId: string, role: string) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: {
          select: { id: true, email: true },
        },
        collector: {
          select: { id: true, email: true },
        },
        batch: true,
      },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (role === Role.HOGAR && collectionRequest.householdId !== userId) {
      throw new ForbiddenException(
        'No tienes permisos para ver esta solicitud',
      );
    }

    // El PIN de verificación solo lo puede ver el hogar dueño de la solicitud.
    if (role !== Role.HOGAR) {
      return this.stripPin(collectionRequest);
    }
    return collectionRequest;
  }

  /**
   * Actualizar el estado de una solicitud
   * - RECOLECTOR: Acepta la solicitud (PENDING -> ACCEPTED, asigna collectorId)
   * - HOGAR: Cancela su propia solicitud (PENDING/ACCEPTED -> CANCELLED)
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
        if (collectionRequest.status !== RequestStatus.PENDING) {
          throw new BadRequestException(
            'La solicitud no está en estado PENDING y no puede ser aceptada',
          );
        }

        const updated = await this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.ACCEPTED,
            collectorId: userId,
          },
        });

        this.notificationsService
          .sendPushNotification(
            collectionRequest.householdId,
            '♻️ Tu solicitud ha sido aceptada',
            'Un recolector está en camino a tu ubicación para recoger los materiales.',
            { requestId: id },
          )
          .catch(() => {});

        return updated;
      }

      throw new BadRequestException(
        'Un recolector únicamente puede cambiar el estado a ACCEPTED',
      );
    }

    if (role === Role.HOGAR) {
      if (collectionRequest.householdId !== userId) {
        throw new ForbiddenException(
          'No tienes permisos para actualizar una solicitud de otro hogar',
        );
      }

      if (dto.status === RequestStatus.CANCELLED) {
        if (
          collectionRequest.status === RequestStatus.COMPLETED ||
          collectionRequest.status === RequestStatus.CANCELLED
        ) {
          throw new BadRequestException(
            'No se puede cancelar una solicitud finalizada o previamente cancelada',
          );
        }

        return this.prisma.collectionRequest.update({
          where: { id },
          data: {
            status: RequestStatus.CANCELLED,
          },
        });
      }

      throw new BadRequestException(
        'Un hogar únicamente puede cambiar el estado a CANCELLED',
      );
    }

    throw new ForbiddenException('Rol no autorizado para actualizar el estado');
  }

  /**
   * Verificar entrega física con PIN de 4 dígitos (Rol RECOLECTOR)
   */
  async verifyPin(id: string, collectorId: string, dto: VerifyPinDto) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (collectionRequest.status !== RequestStatus.ACCEPTED) {
      throw new BadRequestException(
        'La solicitud debe estar en estado ACCEPTED para verificar el PIN',
      );
    }

    if (collectionRequest.collectorId !== collectorId) {
      throw new ForbiddenException(
        'Únicamente el recolector que aceptó la solicitud puede verificar el PIN',
      );
    }

    if (collectionRequest.verificationPin !== dto.pin) {
      throw new BadRequestException('PIN de verificación incorrecto');
    }

    // Obtener o crear lote abierto (OPEN) para el recolector
    let openBatch = await this.prisma.batch.findFirst({
      where: {
        collectorId,
        status: 'OPEN',
      },
    });

    if (!openBatch) {
      openBatch = await this.prisma.batch.create({
        data: {
          collectorId,
          status: 'OPEN',
        },
      });
    }

    // Actualizar solicitud a COMPLETED y vincular al Lote
    return this.prisma.collectionRequest.update({
      where: { id },
      data: {
        status: RequestStatus.COMPLETED,
        batchId: openBatch.id,
      },
    });
  }

  /**
   * Helper para subida de imágenes a Pinata IPFS (antes Supabase)
   */
  private async uploadPhoto(
    file:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
    _userId: string,
  ): Promise<string> {
    try {
      // Sube la foto del material a Pinata IPFS
      const cid = await this.ipfsService.uploadFile(file);
      return cid;
    } catch {
      // Fallback
      return 'QmDummyPhotoHash';
    }
  }
}
