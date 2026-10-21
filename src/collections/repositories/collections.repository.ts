import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CollectionRequest, BatchStatus, Role, RequestStatus, Prisma } from '@prisma/client';
import { ICollectionsRepository } from './collections.repository.interface';
import { FindCollectionsQueryDto } from '../dto/find-collections-query.dto';
import { AvailableCollectionsQueryDto } from '../dto/available-collections-query.dto';
import { PaginatedResultDto } from '../../common/dto/paginated-result.dto';

/**
 * Implementación Concreta de Repositorio (PUCP Disoft - Data Mapper Pattern)
 * Centraliza las consultas, transacciones atómicas y mapeos hacia PostgreSQL vía Prisma.
 */
@Injectable()
export class CollectionsRepository implements ICollectionsRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row || typeof row !== 'object') return row;
    const clone: any = { ...row };
    delete clone.verificationPin;
    return clone;
  }

  async findById(id: string): Promise<CollectionRequest | null> {
    return this.prisma.collectionRequest.findUnique({
      where: { id },
    });
  }

  async findByIdWithDetails(id: string): Promise<any | null> {
    return this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
          },
        },
        collector: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        assignedCenter: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            address: true,
          },
        },
        bids: {
          include: {
            center: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async findOpenBatch(collectorId: string, centerId: string): Promise<any | null> {
    return this.prisma.batch.findFirst({
      where: {
        collectorId,
        destinationCenterId: centerId,
        status: BatchStatus.OPEN,
      },
    });
  }

  async createOpenBatch(collectorId: string, centerId: string): Promise<any> {
    return this.prisma.batch.create({
      data: {
        collectorId,
        destinationCenterId: centerId,
        status: BatchStatus.OPEN,
      },
    });
  }

  async create(data: any): Promise<CollectionRequest> {
    return this.prisma.collectionRequest.create({ data });
  }

  async update(id: string, data: any): Promise<CollectionRequest> {
    return this.prisma.collectionRequest.update({
      where: { id },
      data,
    });
  }

  async atomicCompleteRequest(
    id: string,
    targetBatchId: string | null,
    actualWeights: any,
    householdReward: number,
    txHash: string | null,
  ): Promise<boolean> {
    const rowsAffected = await this.prisma.$executeRaw`
      UPDATE "collection_requests"
      SET 
        status = 'COMPLETED',
        "actualWeights" = ${JSON.stringify(actualWeights)}::jsonb,
        "tokensRewarded" = ${householdReward},
        "blockchainTxHash" = ${txHash},
        "batchId" = ${targetBatchId}::uuid,
        "completedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id = ${id}::uuid
        AND status IN ('ACCEPTED', 'EN_ROUTE', 'ARRIVED');
    `;
    return rowsAffected > 0;
  }

  async findAll(user: { id: string; role: Role }, query: FindCollectionsQueryDto): Promise<PaginatedResultDto<any>> {
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
    } else if (user.role === Role.CENTRO_ACOPIO) {
      where = {
        OR: [
          {
            status: { in: [RequestStatus.PENDING, RequestStatus.AUCTION_ACTIVE] },
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
      if (query.status) {
        where = {
          status: query.status,
          ...(query.status === RequestStatus.PENDING
            ? { assignedCenterId: { not: null }, collectorId: null }
            : { collectorId: user.id }),
        };
      } else {
        where = {
          OR: [
            {
              status: RequestStatus.PENDING,
              assignedCenterId: { not: null },
              collectorId: null,
            },
            {
              collectorId: user.id,
              status: {
                in: [
                  RequestStatus.ACCEPTED,
                  RequestStatus.EN_ROUTE,
                  RequestStatus.ARRIVED,
                  RequestStatus.AUCTION_ASSIGNED,
                ],
              },
            },
          ],
        };
      }
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

  async findAvailable(collectorId: string, query: AvailableCollectionsQueryDto): Promise<PaginatedResultDto<any>> {
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
        AND cr."collectorId" IS NULL
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

  async findOne(id: string, userId: string, role: string): Promise<any> {
    const collectionRequest = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true, address: true, phone: true } },
        collector: { select: { id: true, email: true, name: true, phone: true, profilePhotoUrl: true, reputationScore: true } },
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

    if (this.redisService) {
      try {
        const cachedLoc = await this.redisService.get(`collector:loc:${id}`).catch(() => null);
        if (cachedLoc) {
          (collectionRequest as any).collectorLocation = JSON.parse(cachedLoc);
        }
      } catch (_) {
        // Ignora errores transitorios de lectura de ubicación en caché
      }
    }

    if (role !== Role.HOGAR) {
      return this.stripPin(collectionRequest);
    }
    return collectionRequest;
  }
}
