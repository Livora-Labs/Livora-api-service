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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  BatchStatus,
  ConsolidatedStatus,
  RequestStatus,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { ReceiveBatchDto } from './dto/receive-batch.dto';
import { FindBatchesQueryDto } from './dto/find-batches-query.dto';
import { CreateConsolidatedBatchDto } from './dto/create-consolidated-batch.dto';
import { CorrelationContext } from '../common/context/correlation-context';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { DisputeBatchDto } from './dto/dispute-batch.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketsService } from '../websockets/websockets.service';

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
  ) {}

  /**
   * GET /batches (Rol: RECOLECTOR / CENTRO_ACOPIO)
   * Devuelve el historial de lotes paginado con forzado de seguridad por rol.
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
      // Forzar por seguridad que solo consulte sus propios lotes
      where.collectorId = userId;
    } else if (role === Role.CENTRO_ACOPIO || role === Role.ALMACEN) {
      // Forzar por seguridad que solo consulte los lotes destinados a su centro de acopio o almacén
      where.destinationCenterId = userId;
    } else if (role === Role.ADMIN) {
      // Admin tiene visibilidad global de todos los lotes
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
   * Devuelve todos los lotes en estado OPEN asociados al recolector autenticado,
   * segmentados por Centro de Acopio (destinationCenterId), con soporte de filtro opcional ?centerId.
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
   * Consulta el detalle de un lote específico con validación de pertenencia.
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
   * Asigna un centro de acopio destino y cambia el estado a IN_TRANSIT.
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

    if (
      !destinationCenter ||
      (destinationCenter.role !== Role.CENTRO_ACOPIO &&
        destinationCenter.role !== Role.ALMACEN)
    ) {
      throw new BadRequestException(
        'El centro de acopio o almacén especificado no existe o no posee un rol autorizado',
      );
    }

    return this.prisma.batch.update({
      where: { id },
      data: {
        destinationCenterId: dto.destinationCenterId,
        status: BatchStatus.IN_TRANSIT,
      },
      include: {
        requests: true,
        destinationCenter: {
          select: { id: true, email: true },
        },
      },
    });
  }

  /**
   * POST /batches/:id/receive (Rol: CENTRO_ACOPIO)
   * Endpoint crítico de pesaje industrial y patrón HTTP 202.
   */
  async receiveBatch(id: string, centerId: string, dto: ReceiveBatchDto) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: {
        requests: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    // c) Validación de Idempotencia: Si el lote ya está en estado PROCESSING, RECEIVED o CONSOLIDATED, rechaza con HTTP 409 Conflict
    if (
      batch.status === BatchStatus.PROCESSING ||
      batch.status === BatchStatus.RECEIVED ||
      batch.status === BatchStatus.CONSOLIDATED
    ) {
      throw new ConflictException(
        'El lote ya se encuentra en procesamiento o fue recibido previamente',
      );
    }

    // a) Verifica que el lote esté en estado IN_TRANSIT u OPEN
    if (
      batch.status !== BatchStatus.IN_TRANSIT &&
      batch.status !== BatchStatus.OPEN
    ) {
      throw new BadRequestException(
        'El lote debe estar en estado IN_TRANSIT u OPEN para ser recibido',
      );
    }

    // b) Valida que el centro de acopio autenticado coincida con el destinationCenterId del lote
    if (batch.destinationCenterId !== centerId) {
      throw new ForbiddenException(
        'El centro de acopio autenticado no coincide con el centro de destino asignado al lote',
      );
    }

    // --- Control de Discrepancias entre Estimación y Pesaje Real ---
    let totalEstimatedKg = 0;
    for (const req of batch.requests) {
      if (req.itemsEstimated && typeof req.itemsEstimated === 'object') {
        const estimatedObj = req.itemsEstimated as Record<string, any>;
        for (const val of Object.values(estimatedObj)) {
          const weight = parseFloat(String(val)) || 0;
          totalEstimatedKg += weight;
        }
      }
    }

    let totalActualKg = 0;
    if (dto.materialsActual && typeof dto.materialsActual === 'object') {
      for (const val of Object.values(dto.materialsActual)) {
        const weight = parseFloat(String(val)) || 0;
        totalActualKg += weight;
      }
    }

    let hasDiscrepancy = false;
    let discrepancyNote: string | null = null;
    const tolerancePercent = parseFloat(
      (this.configService &&
        this.configService.get<string>(
          'WEIGHT_DISCREPANCY_TOLERANCE_PERCENT',
        )) ||
        '15',
    );
    const tolerance = tolerancePercent / 100; // Tolerancia del ±15% por defecto

    if (totalEstimatedKg > 0) {
      const diffPercent =
        Math.abs(totalActualKg - totalEstimatedKg) / totalEstimatedKg;
      if (diffPercent > tolerance) {
        hasDiscrepancy = true;
        discrepancyNote = `Discrepancia detectada: estimado total de ${totalEstimatedKg.toFixed(2)} kg vs pesado real de ${totalActualKg.toFixed(2)} kg (desviación del ${(diffPercent * 100).toFixed(1)}%, excede ±${tolerancePercent}% de tolerancia)`;
      }
    } else if (totalActualKg > 0) {
      hasDiscrepancy = true;
      discrepancyNote = `Discrepancia detectada: estimado era 0 kg pero se pesaron reales ${totalActualKg.toFixed(2)} kg`;
    }

    if (hasDiscrepancy) {
      this.logger.warn(
        `[ALERTA ANTI-FRAUDE EN BÁSCULA] Lote ${id}: ${discrepancyNote}. Retenido en FLAGGED_FOR_REVIEW sin minteo automático.`,
      );

      const updatedBatch = await this.prisma.batch.update({
        where: { id },
        data: {
          status: BatchStatus.FLAGGED_FOR_REVIEW,
          materialsActual: dto.materialsActual,
          hasDiscrepancy: true,
          discrepancyNote,
        },
      });

      return {
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        batchId: updatedBatch.id,
        message:
          'Lote retenido para revisión manual (FLAGGED_FOR_REVIEW) por discrepancia de peso superior al 15%. Requiere aprobación manual de Admin antes de mintear EcoTokens.',
        hasDiscrepancy: true,
        discrepancyNote,
      };
    }

    // Transacción Asíncrona:
    // a) Actualiza el estado del lote a PROCESSING, guarda los pesos industriales en materialsActual
    const updatedBatch = await this.prisma.batch.update({
      where: { id },
      data: {
        status: BatchStatus.PROCESSING,
        materialsActual: dto.materialsActual,
        hasDiscrepancy: false,
        discrepancyNote: null,
      },
    });

    // Extraer IDs de hogares participantes desde las solicitudes asociadas
    const householdIds = Array.from(
      new Set(batch.requests.map((req) => req.householdId)),
    );

    // b) Encola un trabajo (Job) en la cola 'blockchain-queue' con el payload completo (Opción 3A)
    //    y define un jobId determinista e inmutable basado en el ID del lote para la idempotencia de Capa 2.
    const jobPayload = {
      batchId: updatedBatch.id,
      collectorId: updatedBatch.collectorId,
      centerId,
      materialsActual: dto.materialsActual,
      householdIds,
      correlationId: CorrelationContext.getCorrelationId(),
    };

    const job = await this.blockchainQueue.add(
      'process-batch-blockchain',
      jobPayload,
      {
        jobId: `batch-${updatedBatch.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    // c) Responde de inmediato al cliente con HTTP 202 Accepted
    return {
      status: BatchStatus.PROCESSING,
      batchId: updatedBatch.id,
      transactionJobId: job.id ? String(job.id) : null,
    };
  }

  /**
   * POST /batches/:id/approve-flagged (Rol: ADMIN / CENTRO_ACOPIO)
   * Aprueba manualmente un lote retenido en FLAGGED_FOR_REVIEW y lo envía a la cola blockchain para minteo de EcoTokens.
   */
  async approveFlaggedBatch(
    id: string,
    approverId: string,
    customNote?: string,
  ) {
    const batch = await this.prisma.batch.findUnique({
      where: { id },
      include: { requests: true },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.status !== BatchStatus.FLAGGED_FOR_REVIEW) {
      throw new BadRequestException(
        `El lote debe estar en estado FLAGGED_FOR_REVIEW para ser aprobado (estado actual: ${batch.status})`,
      );
    }

    const note = customNote
      ? `${batch.discrepancyNote || ''} | Autorizado por ${approverId}: ${customNote}`
      : `${batch.discrepancyNote || ''} | Aprobado manualmente por ${approverId} el ${new Date().toISOString()}`;

    const updatedBatch = await this.prisma.batch.update({
      where: { id },
      data: {
        status: BatchStatus.PROCESSING,
        discrepancyNote: note,
      },
    });

    const householdIds = Array.from(
      new Set(batch.requests.map((req) => req.householdId)),
    );

    const jobPayload = {
      batchId: updatedBatch.id,
      collectorId: updatedBatch.collectorId,
      centerId: updatedBatch.destinationCenterId,
      materialsActual: updatedBatch.materialsActual,
      householdIds,
      correlationId: CorrelationContext.getCorrelationId(),
    };

    const job = await this.blockchainQueue.add(
      'process-batch-blockchain',
      jobPayload,
      {
        jobId: `batch-${updatedBatch.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    return {
      status: BatchStatus.PROCESSING,
      batchId: updatedBatch.id,
      transactionJobId: job.id ? String(job.id) : null,
      message:
        'Lote aprobado exitosamente por Admin y encolado para minteo blockchain de EcoTokens',
    };
  }

  /**
   * POST /consolidated-batches (Rol: CENTRO_ACOPIO)
   * Consolida múltiples lotes en estado RECEIVED en un único ConsolidatedBatch usando Prisma $transaction.
   */
  async createConsolidatedBatch(
    centerId: string,
    dto: CreateConsolidatedBatchDto,
  ) {
    // 1. Obtener todos los lotes especificados
    const batches = await this.prisma.batch.findMany({
      where: {
        id: { in: dto.batchIds },
      },
    });

    if (batches.length !== dto.batchIds.length) {
      throw new NotFoundException(
        'Uno o más lotes especificados no fueron encontrados',
      );
    }

    // 2. Verificar que todos los lotes pertenezcan a este Centro de Acopio y estén en estado RECEIVED
    let totalWeight = 0;

    for (const batch of batches) {
      if (batch.destinationCenterId !== centerId) {
        throw new ForbiddenException(
          `El lote ${batch.id} no está destinado a este Centro de Acopio`,
        );
      }

      if (batch.status !== BatchStatus.RECEIVED) {
        throw new BadRequestException(
          `El lote ${batch.id} debe estar en estado RECEIVED para ser consolidado (estado actual: ${batch.status})`,
        );
      }

      // Sumar pesos desde materialsActual
      if (batch.materialsActual && typeof batch.materialsActual === 'object') {
        const materialsObj = batch.materialsActual as Record<string, number>;
        for (const key of Object.keys(materialsObj)) {
          const val = Number(materialsObj[key]);
          if (!isNaN(val) && val > 0) {
            totalWeight += val;
          }
        }
      }
    }

    // 3. Ejecutar transacción atómica en la base de datos
    return this.prisma.$transaction(async (tx) => {
      // a) Crear el registro ConsolidatedBatch
      const consolidatedBatch = await tx.consolidatedBatch.create({
        data: {
          centerId,
          totalWeight,
          status: ConsolidatedStatus.PENDING_SALE,
        },
      });

      // b) Actualizar todos los lotes individuales pasándolos a CONSOLIDATED y vinculándolos
      await tx.batch.updateMany({
        where: {
          id: { in: dto.batchIds },
        },
        data: {
          status: BatchStatus.CONSOLIDATED,
          consolidatedBatchId: consolidatedBatch.id,
        },
      });

      // c) Retornar el objeto ConsolidatedBatch creado junto con sus lotes asociados
      return tx.consolidatedBatch.findUnique({
        where: { id: consolidatedBatch.id },
        include: {
          batches: true,
          center: {
            select: { id: true, email: true },
          },
        },
      });
    });
  }

  /**
   * POST /batches/:id/fiat-settlement (Rol: CENTRO_ACOPIO)
   * Asienta contablemente la entrega de efectivo (Soles) por el material físico recibido.
   * Cierra la contabilidad dual sin emitir nuevos tokens.
   */
  async fiatSettlement(centerUserId: string, batchId: string) {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        collector: { select: { id: true, name: true, email: true } },
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.destinationCenterId !== centerUserId) {
      throw new ForbiddenException(
        'No tienes permisos para registrar liquidaciones de este lote',
      );
    }

    if (batch.status === ('DISPUTED' as any)) {
      throw new BadRequestException(
        'No se puede asentar pago fiat en un lote con disputa activa',
      );
    }

    if (
      batch.status !== BatchStatus.RECEIVED &&
      batch.status !== BatchStatus.CONSOLIDATED
    ) {
      throw new BadRequestException(
        `Solo lotes en estado RECEIVED o CONSOLIDATED pueden registrar cierre de pago fiat (Estado actual: ${batch.status})`,
      );
    }

    if (batch.fiatSettled) {
      throw new ConflictException(
        'El pago fiat ya ha sido registrado previamente para este lote',
      );
    }

    const updated = await this.prisma.batch.update({
      where: { id: batchId },
      data: {
        fiatSettled: true,
        fiatSettledAt: new Date(),
      },
    });

    // Notificar al recolector
    this.notificationsService
      ?.sendPushNotification(
        batch.collectorId,
        'Pago fiduciario registrado',
        'El Centro de Acopio ha asentado contablemente la entrega de tu pago en efectivo por el lote entregado.',
        { batchId, fiatSettled: 'true' },
      )
      .catch(() => {});

    return {
      message: 'Pago fiat registrado exitosamente',
      batchId: updated.id,
      fiatSettled: updated.fiatSettled,
      fiatSettledAt: updated.fiatSettledAt,
    };
  }

  /**
   * POST /batches/:id/dispute (Rol: RECOLECTOR)
   * Impugna un lote observado por discrepancias (FLAGGED_FOR_REVIEW) y lo congela (DISPUTED).
   * CUMPLIMIENTO LEGAL: Este canal B2B aísla las controversias de inventario del
   * Libro de Reclamaciones (Ley N.º 29571 / Indecopi), evitando contingencias regulatorias B2C.
   */
  async disputeBatch(
    collectorUserId: string,
    batchId: string,
    dto: DisputeBatchDto,
  ) {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        destinationCenter: { select: { id: true, name: true } },
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.collectorId !== collectorUserId) {
      throw new ForbiddenException(
        'Solo el recolector asignado al lote puede impugnar el pesaje',
      );
    }

    if (batch.status !== BatchStatus.FLAGGED_FOR_REVIEW) {
      throw new BadRequestException(
        `Solo lotes con observación de discrepancia (FLAGGED_FOR_REVIEW) pueden ser impugnados (Estado actual: ${batch.status})`,
      );
    }

    const updated = await this.prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'DISPUTED' as any,
        disputeReason: dto.reason,
        disputedAt: new Date(),
      },
    });

    this.logger.warn(
      `[LOGISTIC_DISPUTE] Lote ${batchId} impugnado por recolector ${collectorUserId}. Motivo: ${dto.reason}`,
    );

    if (batch.destinationCenterId) {
      this.notificationsService
        ?.sendPushNotification(
          batch.destinationCenterId,
          'Lote impugnado por el recolector',
          `El recolector ha disputado la discrepancia de pesaje del lote. El lote queda en estado DISPUTED para arbitraje.`,
          { batchId, status: 'DISPUTED' },
        )
        .catch(() => {});
    }

    return updated;
  }

  /**
   * POST /batches/:id/resolve-dispute (Rol: ADMIN)
   * Resolución y arbitraje administrativo de un lote en disputa.
   */
  async resolveDispute(
    _adminUserId: string,
    batchId: string,
    adjustedMaterials?: Record<string, any>,
    resolutionNote?: string,
  ) {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.status !== ('DISPUTED' as any)) {
      throw new BadRequestException(
        `Solo lotes en estado DISPUTED pueden ser resueltos (Estado actual: ${batch.status})`,
      );
    }

    const updated = await this.prisma.batch.update({
      where: { id: batchId },
      data: {
        status: BatchStatus.RECEIVED,
        materialsActual: (adjustedMaterials as any) || (batch.materialsActual as any) || undefined,
        discrepancyNote: resolutionNote
          ? `Arbitraje Admin: ${resolutionNote}`
          : batch.discrepancyNote,
        hasDiscrepancy: false,
      },
    });

    this.notificationsService
      ?.sendPushNotification(
        batch.collectorId,
        'Disputa de lote resuelta',
        'La administración ha revisado y resuelto la discrepancia de tu lote.',
        { batchId, status: 'RECEIVED' },
      )
      .catch(() => {});

    return updated;
  }
}
