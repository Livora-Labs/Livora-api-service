import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SupabaseService } from '../supabase/supabase.service';
import { IpfsService } from '../blockchain/services/ipfs.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { SubmitBidDto } from './dto/submit-bid.dto';
import { SelectBidDto } from './dto/select-bid.dto';
import { AvailableCollectionsQueryDto } from './dto/available-collections-query.dto';
import { RateCollectionDto } from './dto/rate-collection.dto';
import { EditCollectionRequestDto } from './dto/edit-collection-request.dto';
import { BatchStatus, RequestStatus, Role, Prisma } from '@prisma/client';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly ipfsService: IpfsService,
    private readonly blockchainService: BlockchainService,
    private readonly websocketsService: WebsocketsService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly redisService?: RedisService,
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

    const assignmentMode = dto.assignmentMode === 'AUCTION' ? 'AUCTION' : 'AUTOMATIC';

    const newRequest = await this.prisma.collectionRequest.create({
      data: {
        status: RequestStatus.PENDING,
        assignmentMode,
        itemsEstimated: dto.itemsEstimated,
        description: dto.description,
        verificationPin,
        latitude: dto.latitude,
        longitude: dto.longitude,
        photoUrl,
        householdId: userId,
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

    // Persistir PIN en Redis con TTL estricto de 30 minutos (1800s)
    if (this.redisService) {
      await this.redisService.set(
        `pin:collection:${newRequest.id}`,
        verificationPin,
        1800,
      );
    }

    // Emitir en tiempo real a los Centros de Acopio y Recolectores (sin PIN)
    this.websocketsService.emitCollectionCreated(this.stripPin(newRequest));

    // Notificar a los Centros de Acopio sobre la nueva orden
    this.prisma.user
      .findMany({
        where: {
          role: { in: [Role.CENTRO_ACOPIO, Role.ALMACEN] },
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

  /**
   * Postular oferta de tarifario a una solicitud en modo Subasta (Rol: CENTRO_ACOPIO)
   */
  async submitBid(centerId: string, requestId: string, dto: SubmitBidDto) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id: requestId },
      include: { household: { select: { id: true, email: true } } },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('La solicitud no está en estado PENDING y no acepta ofertas');
    }

    if (request.assignmentMode !== 'AUCTION') {
      throw new BadRequestException('La solicitud no está en modalidad de subasta (AUCTION)');
    }

    let proposedRates: Record<string, number> = dto.proposedRates || {};

    // Validar tarifas personalizadas si se proporcionaron
    if (Object.keys(proposedRates).length > 0) {
      for (const [mat, rate] of Object.entries(proposedRates)) {
        const r = Number(rate);
        if (isNaN(r) || r < 0.05) {
          throw new BadRequestException(`La tarifa propuesta para ${mat} debe ser de al menos 0.05 PEN`);
        }
        const parts = r.toString().split('.');
        if (parts.length > 1 && parts[1].length > 2) {
          throw new BadRequestException(`La tarifa propuesta para ${mat} no puede tener más de 2 decimales`);
        }
      }
    }

    // Si no se pasaron tarifas personalizadas, cargar el tarifario vigente del Centro de Acopio
    if (Object.keys(proposedRates).length === 0) {
      const priceList = await this.prisma.acopioPriceList.findMany({
        where: { centerId },
      });

      if (priceList.length === 0) {
        throw new BadRequestException(
          'Debes registrar tu tarifario por kg en tu perfil antes de enviar propuestas.',
        );
      }

      for (const p of priceList) {
        proposedRates[p.materialType] = Number(p.pricePerKg);
      }
    }

    // Calcular montos estimados: total PEN y total EcoTokens para el Hogar (40%)
    let totalEstimatedPenn = 0;
    const items = (request.itemsEstimated as Record<string, number>) || {};
    for (const [mat, weightRaw] of Object.entries(items)) {
      const weight = typeof weightRaw === 'number' ? weightRaw : parseFloat(String(weightRaw)) || 0;
      const rate = proposedRates[mat] || proposedRates[mat.toUpperCase()] || 0;
      totalEstimatedPenn += weight * rate;
    }

    const totalEstimatedEco = parseFloat((totalEstimatedPenn * 0.40).toFixed(2));
    totalEstimatedPenn = parseFloat(totalEstimatedPenn.toFixed(2));

    const existingBid = await this.prisma.acopioBid.findFirst({
      where: { requestId, centerId },
    });

    let bid;
    if (existingBid) {
      bid = await this.prisma.acopioBid.update({
        where: { id: existingBid.id },
        data: {
          proposedRates,
          totalEstimatedPenn,
          totalEstimatedEco,
          status: 'PENDING',
        },
        include: {
          center: { select: { id: true, name: true, email: true, address: true } },
        },
      });
    } else {
      bid = await this.prisma.acopioBid.create({
        data: {
          requestId,
          centerId,
          proposedRates,
          totalEstimatedPenn,
          totalEstimatedEco,
          status: 'PENDING',
        },
        include: {
          center: { select: { id: true, name: true, email: true, address: true } },
        },
      });
    }

    // Notificar al Hogar sobre la nueva propuesta
    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Nueva propuesta de Centro de Acopio',
        `Un centro de acopio ha ofertado S/ ${totalEstimatedPenn.toFixed(2)} PEN (${totalEstimatedEco.toFixed(2)} ECO) por tu material.`,
        { requestId, bidId: bid.id },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionUpdated(this.stripPin(request));
    return bid;
  }

  /**
   * Retirar propuesta de subasta antes de ser aceptada (Rol: CENTRO_ACOPIO)
   */
  async withdrawBid(centerId: string, requestId: string, bidId?: string) {
    const where: any = { requestId, centerId };
    if (bidId) where.id = bidId;

    const bid = await this.prisma.acopioBid.findFirst({ where });
    if (!bid) {
      throw new NotFoundException('Propuesta de subasta no encontrada');
    }

    if (bid.status !== 'PENDING') {
      throw new BadRequestException('Solo se pueden retirar propuestas en estado PENDING');
    }

    await this.prisma.acopioBid.update({
      where: { id: bid.id },
      data: { status: 'WITHDRAWN' },
    });

    return { success: true, message: 'Propuesta retirada exitosamente' };
  }

  /**
   * Hogar selecciona una propuesta ganadora en modo Subasta (Rol: HOGAR)
   */
  async selectBid(householdId: string, requestId: string, dto: SelectBidDto) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    if (request.householdId !== householdId) {
      throw new ForbiddenException('No tienes permisos para gestionar esta solicitud');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('La solicitud ya no se encuentra en estado PENDING');
    }

    const selectedBid = await this.prisma.acopioBid.findUnique({
      where: { id: dto.bidId },
    });

    if (!selectedBid || selectedBid.requestId !== requestId) {
      throw new NotFoundException('Propuesta no encontrada para esta solicitud');
    }

    if (selectedBid.status !== 'PENDING') {
      throw new BadRequestException('La propuesta seleccionada no está disponible');
    }

    // Aceptar la propuesta seleccionada y rechazar las demás dentro de una transacción atómica
    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      // Validar atómicamente que la solicitud siga en estado PENDING
      const currentReq = await tx.collectionRequest.findUnique({
        where: { id: requestId },
      });
      if (!currentReq || currentReq.status !== RequestStatus.PENDING) {
        throw new BadRequestException('La solicitud ya no se encuentra en estado PENDING');
      }

      await tx.acopioBid.update({
        where: { id: selectedBid.id },
        data: { status: 'ACCEPTED' },
      });

      await tx.acopioBid.updateMany({
        where: {
          requestId,
          id: { not: selectedBid.id },
        },
        data: { status: 'REJECTED' },
      });

      return tx.collectionRequest.update({
        where: { id: requestId },
        data: {
          assignedCenterId: selectedBid.centerId,
          agreedRates: selectedBid.proposedRates as any,
        },
        include: {
          household: { select: { id: true, email: true, name: true } },
          assignedCenter: { select: { id: true, name: true, email: true, address: true } },
          bids: {
            include: {
              center: { select: { id: true, name: true, email: true, address: true } },
            },
          },
        },
      });
    });

    // Notificar al Centro de Acopio ganador
    this.notificationsService
      .sendPushNotification(
        selectedBid.centerId,
        'Tu propuesta fue seleccionada',
        'El hogar aceptó tu tarifa. La solicitud ya está disponible para recolección en campo.',
        { requestId },
      )
      .catch(() => {});

    // Notificar a recolectores vía WebSockets
    this.websocketsService.emitCollectionCreated(this.stripPin(updatedRequest));

    return updatedRequest;
  }

  /**
   * Centro de Acopio toma directamente una solicitud en modo Automático (Rol: CENTRO_ACOPIO)
   */
  async claimAutomatic(centerId: string, requestId: string) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('La solicitud no está en estado PENDING');
    }

    if (request.assignmentMode !== 'AUTOMATIC') {
      throw new BadRequestException('La solicitud no está configurada en modo AUTOMATIC');
    }

    if (request.assignedCenterId) {
      throw new BadRequestException('La solicitud ya fue tomada por otro Centro de Acopio');
    }

    const priceList = await this.prisma.acopioPriceList.findMany({
      where: { centerId },
    });

    if (priceList.length === 0) {
      throw new BadRequestException(
        'Debes registrar tu tarifario por kg antes de tomar solicitudes automáticas.',
      );
    }

    const agreedRates: Record<string, number> = {};
    for (const p of priceList) {
      agreedRates[p.materialType] = Number(p.pricePerKg);
    }

    const updatedRequest = await this.prisma.collectionRequest.update({
      where: { id: requestId },
      data: {
        assignedCenterId: centerId,
        agreedRates,
      },
      include: {
        household: { select: { id: true, email: true, name: true } },
        assignedCenter: { select: { id: true, name: true, email: true, address: true } },
      },
    });

    // Notificar al Hogar
    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Centro de Acopio asignado',
        'Un centro de acopio ha tomado tu solicitud y se ha fijado el tarifario de recolección.',
        { requestId },
      )
      .catch(() => {});

    // Emitir a recolectores
    this.websocketsService.emitCollectionCreated(this.stripPin(updatedRequest));

    return updatedRequest;
  }

  /**
   * Listar solicitudes de recolección
   */
  async findAll(user: { id: string; role: Role }, query: FindCollectionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 15;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'updatedAt', 'status'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as 'asc' | 'desc';
    const readPrisma = (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    let where: any;
    let include: any;

    if (user.role === Role.HOGAR) {
      where = {
        householdId: user.id,
        ...(query.status ? { status: query.status } : {}),
      };
      include = {
        assignedCenter: { select: { id: true, name: true, email: true, address: true } },
        collector: { select: { id: true, name: true, email: true } },
        bids: {
          include: {
            center: { select: { id: true, name: true, email: true, address: true } },
          },
        },
        batch: true,
      };
    } else if (user.role === Role.CENTRO_ACOPIO || user.role === Role.ALMACEN) {
      where = {
        OR: [
          {
            status: RequestStatus.PENDING,
            assignmentMode: 'AUCTION',
          },
          {
            status: RequestStatus.PENDING,
            assignmentMode: 'AUTOMATIC',
            assignedCenterId: null,
          },
          {
            assignedCenterId: user.id,
          },
        ],
      };
      include = {
        household: { select: { id: true, email: true, name: true, address: true } },
        assignedCenter: { select: { id: true, name: true, email: true } },
        bids: {
          include: {
            center: { select: { id: true, name: true, email: true, address: true } },
          },
        },
      };
    } else if (user.role === Role.RECOLECTOR) {
      where = {
        OR: [
          {
            status: RequestStatus.PENDING,
            assignedCenterId: { not: null },
          },
          {
            collectorId: user.id,
          },
        ],
      };
      include = {
        household: { select: { id: true, email: true, name: true, address: true } },
        assignedCenter: { select: { id: true, name: true, email: true, address: true } },
      };
    } else if (user.role === Role.ADMIN) {
      where = {};
      include = {
        household: { select: { id: true, email: true, name: true } },
        assignedCenter: { select: { id: true, name: true, email: true } },
        collector: { select: { id: true, email: true, name: true } },
        bids: true,
      };
    } else {
      throw new ForbiddenException('Rol no autorizado para listar solicitudes');
    }

    const [total, requests] = await Promise.all([
      readPrisma.collectionRequest.count({ where }),
      readPrisma.collectionRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include,
      }),
    ]);

    const sanitized = requests.map((r) =>
      user.role === Role.HOGAR ? r : this.stripPin(r),
    );
    return new PaginatedResultDto(sanitized, total, page, limit);
  }

  /**
   * GET /collection-requests/available (Rol: RECOLECTOR)
   * Radar GPS avanzado resuelto al 100% en PostgreSQL mediante PostGIS (ST_DWithin, ST_Distance)
   * e índice espacial GiST, con proyección segura (sin PIN) y verificación de lotes activos vía SQL.
   */
  async findAvailable(collectorId: string, query: AvailableCollectionsQueryDto) {
    const lat = query.lat;
    const lng = query.lng;
    const radiusKm = query.radiusKm ?? 5;
    const radiusMeters = radiusKm * 1000;
    const page = (query as any).page ?? 1;
    const limit = (query as any).limit ?? 15;

    const centerFilter = query.centerId
      ? Prisma.sql`AND cr."assignedCenterId" = ${query.centerId}::uuid`
      : Prisma.empty;

    const activeBatchesFilter = query.onlyActiveBatches
      ? Prisma.sql`
        AND EXISTS (
          SELECT 1 FROM batches b
          WHERE b."collectorId" = ${collectorId}::uuid
            AND b.status = 'OPEN'
            AND b."destinationCenterId" = cr."assignedCenterId"
        )
      `
      : Prisma.empty;

    const rawRows = await this.prisma.$queryRaw<any[]>`
      SELECT 
        cr.id,
        cr.status,
        cr."assignmentMode",
        cr."itemsEstimated",
        cr."actualWeights",
        cr."photoUrl",
        cr.description,
        cr.latitude,
        cr.longitude,
        cr."householdId",
        cr."collectorId",
        cr."assignedCenterId",
        cr."agreedRates",
        cr."escrowLocked",
        cr."batchId",
        cr."createdAt",
        cr."updatedAt",
        ROUND(
          6371000 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(cr.latitude - ${lat}) / 2), 2) +
            COS(RADIANS(${lat})) * COS(RADIANS(cr.latitude)) *
            POWER(SIN(RADIANS(cr.longitude - ${lng}) / 2), 2)
          ))
        )::int AS "distanceMeters",
        ROUND(
          (6371 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(cr.latitude - ${lat}) / 2), 2) +
            COS(RADIANS(${lat})) * COS(RADIANS(cr.latitude)) *
            POWER(SIN(RADIANS(cr.longitude - ${lng}) / 2), 2)
          )))::numeric,
          2
        )::float AS "distanceKm",
        jsonb_build_object(
          'id', h.id,
          'name', h.name,
          'address', h.address,
          'phone', h.phone
        ) AS household,
        CASE 
          WHEN ac.id IS NOT NULL THEN
            jsonb_build_object(
              'id', ac.id,
              'name', ac.name,
              'email', ac.email,
              'address', ac.address,
              'phone', ac.phone
            )
          ELSE NULL
        END AS "assignedCenter",
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', b.id,
                'requestId', b."requestId",
                'centerId', b."centerId",
                'proposedRates', b."proposedRates",
                'totalEstimatedPenn', b."totalEstimatedPenn",
                'totalEstimatedEco', b."totalEstimatedEco",
                'status', b.status,
                'center', jsonb_build_object(
                  'id', bc.id,
                  'name', bc.name,
                  'email', bc.email,
                  'address', bc.address
                )
              )
            )
            FROM acopio_bids b
            JOIN users bc ON bc.id = b."centerId"
            WHERE b."requestId" = cr.id
          ),
          '[]'::jsonb
        ) AS bids
      FROM collection_requests cr
      JOIN users h ON h.id = cr."householdId"
      LEFT JOIN users ac ON ac.id = cr."assignedCenterId"
      WHERE cr.status = 'PENDING'
        AND cr."assignedCenterId" IS NOT NULL
        AND (
          6371000 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(cr.latitude - ${lat}) / 2), 2) +
            COS(RADIANS(${lat})) * COS(RADIANS(cr.latitude)) *
            POWER(SIN(RADIANS(cr.longitude - ${lng}) / 2), 2)
          ))
        ) <= ${radiusMeters}
        ${centerFilter}
        ${activeBatchesFilter}
      ORDER BY "distanceMeters" ASC;
    `;

    const total = rawRows.length;
    const pagedRows = rawRows.slice((page - 1) * limit, page * limit);
    return new PaginatedResultDto(pagedRows, total, page, limit);
  }

  /**
   * Quita el PIN de verificación de una solicitud para proteger privacidad
   */
  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row || typeof row !== 'object') return row;
    const clone: any = { ...row };
    delete clone.verificationPin;
    return clone;
  }

  /**
   * Obtener detalle de una solicitud por ID
   */
  async findOne(id: string, userId: string, role: string) {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true, address: true, phone: true } },
        collector: { select: { id: true, email: true, name: true, phone: true } },
        assignedCenter: { select: { id: true, name: true, email: true, address: true } },
        bids: {
          include: {
            center: { select: { id: true, name: true, email: true, address: true } },
          },
        },
        batch: true,
      },
    });

    if (!collectionRequest) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (role === Role.HOGAR && collectionRequest.householdId !== userId) {
      throw new ForbiddenException('No tienes permisos para ver esta solicitud');
    }

    if (role !== Role.HOGAR) {
      return this.stripPin(collectionRequest);
    }
    return collectionRequest;
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
        if (collectionRequest.status !== RequestStatus.PENDING) {
          throw new BadRequestException(
            'La solicitud no está en estado PENDING y no puede ser aceptada',
          );
        }

        if (!collectionRequest.assignedCenterId) {
          throw new BadRequestException(
            'La solicitud aún no tiene un Centro de Acopio asignado con tarifario.',
          );
        }

        // Calcular garantía requerida en EcoTokens: 50% del valor estimado total (40% Hogar + 10% Livora)
        const agreedRates = (collectionRequest.agreedRates as Record<string, number>) || {};
        const items = (collectionRequest.itemsEstimated as Record<string, number>) || {};
        let totalEstimatedPenn = 0;

        for (const [mat, rawWeight] of Object.entries(items)) {
          const weight = typeof rawWeight === 'number' ? rawWeight : parseFloat(String(rawWeight)) || 0;
          const rate = agreedRates[mat] || agreedRates[mat.toUpperCase()] || 1.0;
          totalEstimatedPenn += weight * rate;
        }

        const requiredEscrow = parseFloat((totalEstimatedPenn * 0.50).toFixed(2));

        // Consultar saldo disponible del recolector
        let totalBalance = 0;
        const collector = await this.prisma.user.findUnique({
          where: { id: userId },
        });

        if (collector?.walletAddress) {
          try {
            const balStr = await this.blockchainService.getBalance(collector.walletAddress);
            totalBalance = parseFloat(balStr) || 0;
          } catch {
            totalBalance = 0;
          }
        }

        // Si no hay saldo on-chain, sumar depósitos Niubiz completados como fallback
        if (totalBalance === 0) {
          const payments = await this.prisma.paymentTransaction.findMany({
            where: { userId, status: 'COMPLETED' },
            select: { tokenAmount: true },
          });
          totalBalance = payments.reduce((sum, p) => sum + Number(p.tokenAmount), 0);
        }

        // Sumar garantías activas actualmente retenidas
        const activeEscrows = await this.prisma.collectionRequest.aggregate({
          where: {
            collectorId: userId,
            status: RequestStatus.ACCEPTED,
          },
          _sum: { escrowLocked: true },
        });

        const currentLocked = Number(activeEscrows._sum.escrowLocked || 0);
        const freeBalance = Math.max(0, totalBalance - currentLocked);

        if (freeBalance < requiredEscrow) {
          throw new BadRequestException(
            `Saldo insuficiente en EcoTokens. Se requiere una garantía de ${requiredEscrow.toFixed(2)} ECO (40% Hogar + 10% Livora), pero tu saldo libre es de ${freeBalance.toFixed(2)} ECO. Por favor recarga tu saldo vía Niubiz.`,
          );
        }

        // Buscar o crear sub-lote OPEN para la combinación (recolector + centro de acopio comprador)
        let openBatch: any = null;
        if (collectionRequest.assignedCenterId) {
          openBatch = await this.prisma.batch.findFirst({
            where: {
              collectorId: userId,
              destinationCenterId: collectionRequest.assignedCenterId,
              status: BatchStatus.OPEN,
            },
          });

          if (!openBatch) {
            openBatch = await this.prisma.batch.create({
              data: {
                collectorId: userId,
                destinationCenterId: collectionRequest.assignedCenterId,
                status: BatchStatus.OPEN,
              },
            });
          }
        }

        const batchId = openBatch ? openBatch.id : null;
        const rowsAffected = await this.prisma.$executeRaw`
          UPDATE collection_requests
          SET status = 'ACCEPTED'::"RequestStatus",
              "collectorId" = ${userId}::uuid,
              "escrowLocked" = ${requiredEscrow}::numeric,
              "batchId" = ${batchId}::uuid,
              "updatedAt" = NOW()
          WHERE id = ${id}::uuid
            AND status = 'PENDING'::"RequestStatus"
        `;

        if (rowsAffected === 0) {
          throw new ConflictException(
            'La solicitud ya fue tomada por otro recolector o ya no se encuentra en estado pendiente',
          );
        }

        const updated = await this.prisma.collectionRequest.findUnique({
          where: { id },
          include: {
            household: { select: { id: true, email: true, name: true } },
            assignedCenter: { select: { id: true, name: true, email: true } },
            batch: true,
          },
        });

        this.notificationsService
          .sendPushNotification(
            collectionRequest.householdId,
            'Tu solicitud ha sido aceptada',
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
            escrowLocked: 0,
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
   * Verificar entrega física con PIN de 4 dígitos y liquidar tokens con pesos reales (Rol: RECOLECTOR)
   */
  async verifyPin(id: string, collectorId: string, dto: VerifyPinDto) {
    const lockKey = `lock:verify:pin:${id}`;
    if (this.redisService) {
      const acquired = await this.redisService.setNX(lockKey, '1', 30);
      if (!acquired) {
        throw new ConflictException(
          'Verificación en proceso, por favor espere',
        );
      }
    }

    try {
      const collectionRequest = await this.prisma.collectionRequest.findUnique({
        where: { id },
        include: {
          household: true,
          collector: true,
        },
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

      if (this.redisService) {
        const cachedPin = await this.redisService.get(`pin:collection:${id}`);
        if (cachedPin && cachedPin !== dto.pin) {
          throw new BadRequestException('PIN de verificación incorrecto');
        }
      }

      if (collectionRequest.verificationPin !== dto.pin) {
        throw new BadRequestException('PIN de verificación incorrecto o expirado');
      }

      // Invalidar PIN en Redis tras uso exitoso
      if (this.redisService) {
        await this.redisService.del(`pin:collection:${id}`);
      }

      // Validar pesos reales si fueron provistos
      if (dto.actualWeights && typeof dto.actualWeights === 'object') {
        for (const [mat, weight] of Object.entries(dto.actualWeights)) {
          const w = Number(weight);
          if (isNaN(w) || w < 0.5) {
            throw new BadRequestException(`El peso real ajustado para ${mat} debe ser de al menos 0.5 kg`);
          }
          const parts = w.toString().split('.');
          if (parts.length > 1 && parts[1].length > 2) {
            throw new BadRequestException(`El peso real de ${mat} no puede tener más de 2 decimales`);
          }
        }
      }

      // Calcular distribución según peso real medido en domicilio
      const actualWeights =
        dto.actualWeights && Object.keys(dto.actualWeights).length > 0
          ? dto.actualWeights
          : (collectionRequest.itemsEstimated as Record<string, number>) || {};

      const agreedRates = (collectionRequest.agreedRates as Record<string, number>) || {};
      let totalActualValue = 0;

      for (const [mat, rawWeight] of Object.entries(actualWeights)) {
        const weight = typeof rawWeight === 'number' ? rawWeight : parseFloat(String(rawWeight)) || 0;
        const rate = agreedRates[mat] || agreedRates[mat.toUpperCase()] || 1.0;
        totalActualValue += weight * rate;
      }

      const hogarAmount = parseFloat((totalActualValue * 0.40).toFixed(2));
      const treasuryAmount = parseFloat((totalActualValue * 0.10).toFixed(2));

      const householdUser = collectionRequest.household;
      const collectorUser = collectionRequest.collector;
      const treasuryWallet =
        (this.configService && this.configService.get<string>('LIVORA_TREASURY_WALLET')) ||
        this.blockchainService.getWorkerAddress();

      const encryptionKey =
        (this.configService &&
          (this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
            this.configService.get<string>('ENCRYPTION_KEY'))) ||
        (process.env.NODE_ENV === 'test'
          ? 'test_isolated_wallet_encryption_key_32c'
          : '');
      if (!encryptionKey && process.env.NODE_ENV !== 'test') {
        throw new Error(
          'CRITICAL SECURITY ERROR: WALLET_ENCRYPTION_KEY es obligatoria para transferencias delegadas.',
        );
      }

      // Transferir 40% al Hogar en EcoTokens
      if (collectorUser?.encryptedPrivateKey && householdUser?.walletAddress && hogarAmount > 0) {
        try {
          const privKey = CryptoUtil.decrypt(collectorUser.encryptedPrivateKey, encryptionKey);
          await this.blockchainService.executeSubsidizedTransfer(
            privKey,
            householdUser.walletAddress,
            hogarAmount,
          );
        } catch (err: any) {
          this.logger.warn(`Transferencia subsidiada a Hogar: ${err.message}`);
        }
      }

      // Transferir 10% a Tesorería de Livora en EcoTokens
      if (
        collectorUser?.encryptedPrivateKey &&
        treasuryWallet &&
        treasuryAmount > 0 &&
        treasuryWallet !== collectorUser.walletAddress
      ) {
        try {
          const privKey = CryptoUtil.decrypt(collectorUser.encryptedPrivateKey, encryptionKey);
          await this.blockchainService.executeSubsidizedTransfer(
            privKey,
            treasuryWallet,
            treasuryAmount,
          );
        } catch (err: any) {
          this.logger.warn(`Transferencia subsidiada a Tesorería: ${err.message}`);
        }
      }

      // Obtener o crear sub-lote abierto (OPEN) para el recolector y el centro de acopio específico
      let targetBatchId = collectionRequest.batchId;
      if (!targetBatchId) {
        let openBatch = await this.prisma.batch.findFirst({
          where: {
            collectorId,
            destinationCenterId: collectionRequest.assignedCenterId,
            status: BatchStatus.OPEN,
          },
        });

        if (!openBatch && collectionRequest.assignedCenterId) {
          openBatch = await this.prisma.batch.create({
            data: {
              collectorId,
              destinationCenterId: collectionRequest.assignedCenterId,
              status: BatchStatus.OPEN,
            },
          });
        }
        targetBatchId = openBatch ? openBatch.id : null;
      }

      // Actualización atómica condicional anti-race condition
      const updatedCount = await this.prisma.$executeRaw`
        UPDATE collection_requests
        SET status = 'COMPLETED', "batchId" = ${targetBatchId}::uuid, "actualWeights" = ${JSON.stringify(actualWeights)}::jsonb, "escrowLocked" = 0, "updatedAt" = NOW()
        WHERE id = ${id}::uuid AND status = 'ACCEPTED'
      `;

      if (updatedCount === 0) {
        throw new BadRequestException(
          'La solicitud ya fue procesada o no está en estado ACCEPTED',
        );
      }

      const completed = await this.prisma.collectionRequest.findUnique({
        where: { id },
        include: {
          household: { select: { id: true, email: true, name: true } },
          assignedCenter: { select: { id: true, name: true, email: true } },
        },
      });

      this.notificationsService
        .sendPushNotification(
          collectionRequest.householdId,
          'Recolección completada con éxito',
          `Se han acreditado ${hogarAmount.toFixed(2)} EcoTokens a tu billetera por tu material reciclado.`,
          { requestId: id },
        )
        .catch(() => {});

      return completed!;
    } finally {
      if (this.redisService) {
        await this.redisService.del(lockKey);
      }
    }
  }

  /**
   * Permite a un recolector liberar/abandonar una solicitud de recolección aceptada
   * por contingencia operativa (avería vehicular, emergencia) y retornarla a PENDING
   * para que otro recolector pueda atenderla de inmediato.
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

    // Transacción atómica para retornar a PENDING y resetear asignaciones y escrow
    const updatedRequest = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.collectionRequest.update({
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

      return updated;
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

    return this.stripPin(updatedRequest);
  }

  /**
   * POST /collection-requests/:id/rate (Rol: HOGAR)
   * Calificar servicio completado (1 a 5 estrellas + feedback opcional).
   * Recalcula dinámicamente el promedio móvil continuo del recolector:
   * nueva_reputacion = ((reputacion_actual * total_calificaciones) + nuevo_rating) / (total_calificaciones + 1)
   * y genera alerta administrativa / QA si score < 3.0 con al menos 5 calificaciones.
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
      throw new ConflictException('Esta solicitud ya cuenta con una calificación registrada');
    }

    // Actualizar solicitud
    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        rating: dto.rating,
        feedback: dto.feedback,
      },
    });

    let newReputation = 5.0;
    let requiresQa = false;

    // Recalcular promedio continuo del recolector
    if (request.collectorId) {
      const collector = await this.prisma.user.findUnique({
        where: { id: request.collectorId },
        select: { id: true, reputationScore: true, totalRatings: true, requiresQaReview: true },
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
   * PATCH /collection-requests/:id (Rol: HOGAR)
   * Edición parcial de materiales y descripción únicamente en estado PENDING.
   * Lanza 409 Conflict si la orden ya fue aceptada por un recolector o no está en PENDING.
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
      throw new ForbiddenException('No tienes permisos para modificar esta solicitud');
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new ConflictException('Tu solicitud ya está en curso y no puede ser modificada');
    }

    const itemsToUpdate = dto.itemsEstimated
      ? JSON.stringify(dto.itemsEstimated)
      : JSON.stringify(request.itemsEstimated);
    const descToUpdate = dto.description !== undefined ? dto.description : request.description;

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
      throw new ConflictException('Tu solicitud ya está en curso y no puede ser modificada');
    }

    const updated = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true, address: true } },
        assignedCenter: { select: { id: true, name: true, email: true, address: true } },
      },
    });

    if (updated) {
      this.websocketsService.emitCollectionCreated(this.stripPin(updated));
    }

    return updated;
  }

  /**
   * Helper para subida de imágenes a Pinata IPFS
   */
  private async uploadPhoto(
    file:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
    _userId: string,
  ): Promise<string> {
    try {
      const cid = await this.ipfsService.uploadFile(file);
      return cid;
    } catch {
      return 'QmDummyPhotoHash';
    }
  }
}
