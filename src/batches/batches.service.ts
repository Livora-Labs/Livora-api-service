import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  BatchStatus,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { ReceiveBatchDto } from './dto/receive-batch.dto';
import { FindBatchesQueryDto } from './dto/find-batches-query.dto';
import { CreateConsolidatedBatchDto } from './dto/create-consolidated-batch.dto';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { DisputeBatchDto } from './dto/dispute-batch.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketsService } from '../websockets/websockets.service';

import { BatchesRepository } from './repositories/batches.repository';
import { BatchReceptionService } from './services/batch-reception.service';
import { BatchDisputeService } from './services/batch-dispute.service';
import { BatchSettlementService } from './services/batch-settlement.service';
import { BatchConsolidationService } from './services/batch-consolidation.service';

/**
 * BatchesService - Fachada Orquestadora de Lotes (PUCP Disoft - GoF Facade Pattern)
 * Coordina las operaciones del ciclo de vida industrial de lotes de reciclaje:
 * - BatchReceptionService (Recepción, pesaje, control de tolerancia ±15% y despacho BullMQ)
 * - BatchDisputeService (Impugnación, congelamiento y arbitraje B2B)
 * - BatchSettlementService (Asentamiento contable fiduciario en Soles)
 * - BatchConsolidationService (Consolidación jerárquica con Patrón Composite y redirección en ruta)
 * - BatchesRepository (Acceso a datos desacoplado de persistencia)
 */
@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);
  private readonly repository: BatchesRepository;
  private readonly receptionService: BatchReceptionService;
  private readonly disputeService: BatchDisputeService;
  private readonly settlementService: BatchSettlementService;
  private readonly consolidationService: BatchConsolidationService;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
    @Optional() repository?: BatchesRepository,
    @Optional() receptionService?: BatchReceptionService,
    @Optional() disputeService?: BatchDisputeService,
    @Optional() settlementService?: BatchSettlementService,
    @Optional() consolidationService?: BatchConsolidationService,
  ) {
    this.repository = repository ?? new BatchesRepository(this.prisma);
    this.receptionService =
      receptionService ??
      new BatchReceptionService(
        this.prisma,
        this.blockchainQueue,
        this.notificationsService,
        this.websocketsService,
        this.configService,
        this.repository,
      );
    this.disputeService =
      disputeService ??
      new BatchDisputeService(
        this.prisma,
        this.notificationsService,
        this.websocketsService,
      );
    this.settlementService =
      settlementService ??
      new BatchSettlementService(
        this.prisma,
        this.notificationsService,
        this.websocketsService,
      );
    this.consolidationService =
      consolidationService ??
      new BatchConsolidationService(
        this.prisma,
        this.notificationsService,
        this.websocketsService,
      );
  }

  // ==========================================
  // CONSULTAS Y LISTADOS (Repository Queries)
  // ==========================================

  /**
   * GET /batches (Rol: RECOLECTOR / CENTRO_ACOPIO / ADMIN)
   */
  async findAll(userId: string, role: string, query: FindBatchesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 15;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'updatedAt', 'status'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as
      'asc' | 'desc';

    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (role === Role.RECOLECTOR) {
      where.collectorId = userId;
    } else if (role === Role.CENTRO_ACOPIO) {
      where.destinationCenterId = userId;
    } else if (role === Role.ADMIN) {
      // Visibilidad global
    } else {
      throw new ForbiddenException('Rol no autorizado para listar lotes');
    }

    const readPrisma = (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    const [total, batches] = await Promise.all([
      readPrisma.batch.count({ where }),
      readPrisma.batch.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sanitizedSortBy]: sortOrder },
        include: {
          collector: {
            select: { id: true, email: true },
          },
          destinationCenter: {
            select: { id: true, email: true },
          },
          requests: {
            include: {
              household: {
                select: { id: true, email: true },
              },
            },
          },
        },
      }),
    ]);

    return new PaginatedResultDto(batches, total, page, limit);
  }

  /**
   * GET /batches/open (Rol: RECOLECTOR)
   */
  async getOpenBatch(collectorId: string, centerId?: string) {
    const where: any = {
      collectorId,
      status: BatchStatus.OPEN,
    };

    if (centerId) {
      where.destinationCenterId = centerId;
    }

    const readPrisma = (this.prisma.getReadClient && this.prisma.getReadClient()) || this.prisma;

    return readPrisma.batch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        destinationCenter: {
          select: { id: true, email: true, name: true, address: true, phone: true },
        },
        requests: {
          include: {
            household: {
              select: { id: true, email: true, name: true, address: true, phone: true },
            },
            assignedCenter: {
              select: { id: true, email: true, name: true, address: true, phone: true },
            },
          },
        },
      },
    });
  }

  /**
   * GET /batches/:id
   */
  async findOne(id: string, user: { id: string; role: Role }) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: {
        collector: {
          select: { id: true, email: true },
        },
        destinationCenter: {
          select: { id: true, email: true, name: true, address: true, phone: true },
        },
        requests: {
          include: {
            household: {
              select: { id: true, email: true, name: true, address: true, phone: true },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (user.role === Role.RECOLECTOR && batch.collectorId !== user.id) {
      throw new ForbiddenException('No tienes permiso para consultar este lote');
    }

    if (
      user.role === Role.CENTRO_ACOPIO &&
      batch.destinationCenterId &&
      batch.destinationCenterId !== user.id
    ) {
      throw new ForbiddenException('Este lote no está destinado a tu centro de acopio');
    }

    return batch;
  }

  /**
   * PATCH /batches/:id (Rol: RECOLECTOR)
   */
  async updateBatch(id: string, collectorId: string, dto: UpdateBatchDto) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.collectorId !== collectorId) {
      throw new ForbiddenException(
        'No tienes permisos para modificar este lote',
      );
    }

    if (batch.status !== BatchStatus.OPEN) {
      throw new BadRequestException(
        'Solo se pueden actualizar lotes en estado OPEN',
      );
    }

    const destinationCenter = await this.prisma.user.findUnique({
      where: { id: dto.destinationCenterId },
    });

    if (!destinationCenter || destinationCenter.role !== Role.CENTRO_ACOPIO) {
      throw new BadRequestException(
        'El centro de acopio especificado no existe o no posee un rol autorizado',
      );
    }

    const updated = await this.prisma.batch.update({
      where: { id },
      data: {
        destinationCenterId: dto.destinationCenterId,
        status: BatchStatus.IN_TRANSIT,
      },
      include: {
        requests: true,
        destinationCenter: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    this.websocketsService?.emitUserEvent(
      dto.destinationCenterId,
      'batch:dispatched',
      updated,
    );
    this.websocketsService?.emitUserEvent(collectorId, 'batch:updated', updated);

    this.notificationsService
      ?.sendPushNotification(
        dto.destinationCenterId,
        'Nuevo lote en camino',
        'Un recolector ha despachado un lote hacia tu centro de acopio.',
        {
          batchId: id,
          status: 'IN_TRANSIT',
          channelId: 'livora_collections_urgent',
        },
      )
      .catch(() => {});

    return updated;
  }

  // ==========================================
  // RECEPCIÓN Y PESAJE (Reception Subsystem)
  // ==========================================

  async receiveBatch(id: string, centerId: string, dto: ReceiveBatchDto) {
    return this.receptionService.receiveBatch(id, centerId, dto);
  }

  async approveFlaggedBatch(
    id: string,
    approverId: string,
    customNote?: string,
  ) {
    return this.receptionService.approveFlaggedBatch(id, approverId, customNote);
  }

  // ==========================================
  // DISPUTAS Y ARBITRAJE B2B (Dispute Subsystem)
  // ==========================================

  async disputeBatch(
    collectorUserId: string,
    batchId: string,
    dto: DisputeBatchDto,
  ) {
    return this.disputeService.disputeBatch(collectorUserId, batchId, dto);
  }

  async resolveDispute(
    adminUserId: string,
    batchId: string,
    adjustedMaterials?: Record<string, any>,
    resolutionNote?: string,
  ) {
    return this.disputeService.resolveDispute(
      adminUserId,
      batchId,
      adjustedMaterials,
      resolutionNote,
    );
  }

  // ==========================================
  // LIQUIDACIÓN FIDUCIARIA (Settlement Subsystem)
  // ==========================================

  async fiatSettlement(centerUserId: string, batchId: string) {
    return this.settlementService.fiatSettlement(centerUserId, batchId);
  }

  // ==========================================
  // CONSOLIDACIÓN Y RUTEO (Consolidation Subsystem)
  // ==========================================

  async createConsolidatedBatch(
    centerId: string,
    dto: CreateConsolidatedBatchDto,
  ) {
    return this.consolidationService.createConsolidatedBatch(centerId, dto);
  }

  async rerouteBatch(
    batchId: string,
    collectorId: string,
    newCenterId: string,
    reason?: string,
    proofPhotoUrl?: string,
  ) {
    return this.consolidationService.rerouteBatch(
      batchId,
      collectorId,
      newCenterId,
      reason,
      proofPhotoUrl,
    );
  }
}
