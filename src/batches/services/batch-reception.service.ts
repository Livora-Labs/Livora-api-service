import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { BatchStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { BatchesRepository } from '../repositories/batches.repository';
import { ReceiveBatchDto } from '../dto/receive-batch.dto';
import { CorrelationContext } from '../../common/context/correlation-context';

/**
 * Servicio de Recepción y Pesaje Industrial (PUCP Disoft - SRP & Antipatrón The Blob)
 * Encapsula el pesaje en báscula, cálculo de mermas, control de tolerancias (15%),
 * detección de discrepancias y despacho asíncrono hacia la cola BullMQ de Soroban.
 */
@Injectable()
export class BatchReceptionService {
  private readonly logger = new Logger(BatchReceptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('blockchain-queue') private readonly blockchainQueue: Queue,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly repository?: BatchesRepository,
  ) {}

  /**
   * POST /batches/:id/receive (Rol: CENTRO_ACOPIO)
   * Recepción física en báscula con verificación estricta de tolerancia y despacho HTTP 202.
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

    if (
      batch.status === BatchStatus.PROCESSING ||
      batch.status === BatchStatus.RECEIVED ||
      batch.status === BatchStatus.CONSOLIDATED
    ) {
      throw new ConflictException(
        'El lote ya se encuentra en procesamiento o fue recibido previamente',
      );
    }

    if (
      batch.status !== BatchStatus.IN_TRANSIT &&
      batch.status !== BatchStatus.OPEN
    ) {
      throw new BadRequestException(
        'El lote debe estar en estado IN_TRANSIT u OPEN para ser recibido',
      );
    }

    if (batch.destinationCenterId !== centerId) {
      throw new ForbiddenException(
        'El centro de acopio autenticado no coincide con el centro de destino asignado al lote',
      );
    }

    // Control de Discrepancias entre Estimación y Pesaje Real
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
    const tolerance = tolerancePercent / 100;

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

      this.websocketsService?.emitUserEvent(
        batch.collectorId,
        'batch:updated',
        updatedBatch,
      );
      this.websocketsService?.emitUserEvent(
        centerId,
        'batch:updated',
        updatedBatch,
      );

      return {
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        batchId: updatedBatch.id,
        message:
          'Lote retenido para revisión manual (FLAGGED_FOR_REVIEW) por discrepancia de peso superior al 15%. Requiere aprobación manual de Admin antes de mintear EcoTokens.',
        hasDiscrepancy: true,
        discrepancyNote,
      };
    }

    const isPartial = dto.wasteWeightKg !== undefined && Number(dto.wasteWeightKg) > 0;
    const targetStatus = isPartial ? BatchStatus.PARTIALLY_ACCEPTED : BatchStatus.PROCESSING;

    const updatedBatch = await this.prisma.batch.update({
      where: { id },
      data: {
        status: targetStatus,
        materialsActual: dto.materialsActual,
        hasDiscrepancy: false,
        discrepancyNote: isPartial
          ? `Aceptado parcialmente con merma: ${dto.wasteWeightKg} kg descartados. Peso neto útil: ${dto.usefulWeightKg ?? 'N/A'} kg.`
          : null,
      },
    });

    const householdIds = Array.from(
      new Set(batch.requests.map((req) => req.householdId)),
    );

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

    this.websocketsService?.emitUserEvent(
      updatedBatch.collectorId,
      'batch:updated',
      updatedBatch,
    );
    this.websocketsService?.emitUserEvent(
      centerId,
      'batch:updated',
      updatedBatch,
    );

    return {
      status: BatchStatus.PROCESSING,
      batchId: updatedBatch.id,
      transactionJobId: job.id ? String(job.id) : null,
    };
  }

  /**
   * POST /batches/:id/approve-flagged (Rol: ADMIN / CENTRO_ACOPIO)
   * Aprueba manualmente un lote en FLAGGED_FOR_REVIEW y lo despacha a la cola BullMQ.
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
        `Solo lotes en estado FLAGGED_FOR_REVIEW pueden ser aprobados manualmente (Estado actual: ${batch.status})`,
      );
    }

    const updatedBatch = await this.prisma.batch.update({
      where: { id },
      data: {
        status: BatchStatus.PROCESSING,
        discrepancyNote: customNote
          ? `Aprobado manualmente por ${approverId}: ${customNote}`
          : `Aprobado manualmente por usuario ${approverId}. Se procede con minteo.`,
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

    this.logger.log(
      `[ADMIN OVERRIDE] Lote retenido ${id} aprobado y encolado en BullMQ con jobId: ${job.id}`,
    );

    return {
      message: 'Lote aprobado y encolado para liquidación blockchain exitosamente',
      status: BatchStatus.PROCESSING,
      batchId: updatedBatch.id,
      transactionJobId: job.id ? String(job.id) : null,
    };
  }
}
