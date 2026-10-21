import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { BatchStatus, ConsolidatedStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { CreateConsolidatedBatchDto } from '../dto/create-consolidated-batch.dto';
import { BatchStateMachine } from '../states/batch-state-machine';
import { ConsolidatedBatchComposite, BatchLeaf } from '../composites/batch-composite';

/**
 * Servicio de Consolidación y Ruteo de Lotes (PUCP Disoft - Composite & State Pattern)
 * Coordina la agregación jerárquica de lotes recibidos en macro-lotes B2B y el desvío dinámico en ruta.
 */
@Injectable()
export class BatchConsolidationService {
  private readonly logger = new Logger(BatchConsolidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
  ) {}

  /**
   * Consolida múltiples lotes en estado RECEIVED en un único ConsolidatedBatch.
   * Utiliza el Patrón Composite (PUCP Disoft Diapositiva 05) para calcular pesos y agregaciones.
   */
  async createConsolidatedBatch(
    centerId: string,
    dto: CreateConsolidatedBatchDto,
  ) {
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

    // Instancia el componente Composite
    const composite = new ConsolidatedBatchComposite(`temp-composite-${Date.now()}`);

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

      const materials = (batch.materialsActual as Record<string, number>) || {};
      composite.add(new BatchLeaf(batch.id, materials));
    }

    const totalWeight = composite.getTotalWeightKg();

    return this.prisma.$transaction(async (tx) => {
      const consolidatedBatch = await tx.consolidatedBatch.create({
        data: {
          centerId,
          totalWeight,
          status: ConsolidatedStatus.PENDING_SALE,
        },
      });

      await tx.batch.updateMany({
        where: {
          id: { in: dto.batchIds },
        },
        data: {
          status: BatchStatus.CONSOLIDATED,
          consolidatedBatchId: consolidatedBatch.id,
        },
      });

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
   * POST /batches/:id/reroute (Rol: RECOLECTOR)
   * Redirige un lote en tránsito hacia un centro de acopio alternativo por contingencia operativa.
   */
  async rerouteBatch(
    batchId: string,
    collectorId: string,
    newCenterId: string,
    reason?: string,
    proofPhotoUrl?: string,
  ) {
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      include: { destinationCenter: true },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    if (batch.collectorId !== collectorId) {
      throw new ForbiddenException('Solo el recolector a cargo del lote puede redirigirlo');
    }

    if (batch.status !== BatchStatus.OPEN && batch.status !== BatchStatus.IN_TRANSIT) {
      throw new BadRequestException(
        `Solo lotes en estado OPEN o IN_TRANSIT pueden ser redirigidos (Estado actual: ${batch.status})`,
      );
    }
    BatchStateMachine.validateTransition(batch.status, BatchStatus.REROUTED);

    if (batch.destinationCenterId === newCenterId) {
      throw new BadRequestException('El nuevo centro de acopio no puede ser idéntico al actual');
    }

    const newCenter = await this.prisma.user.findUnique({
      where: { id: newCenterId },
    });

    if (!newCenter || newCenter.role !== Role.CENTRO_ACOPIO) {
      throw new BadRequestException('El centro de acopio destino no existe o no posee un rol autorizado');
    }

    const oldCenterId = batch.destinationCenterId;

    const updatedBatch = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.batch.update({
        where: { id: batchId },
        data: {
          status: BatchStatus.REROUTED,
          destinationCenterId: newCenterId,
        },
        include: {
          destinationCenter: { select: { id: true, name: true, email: true, address: true } },
        },
      });

      await tx.disputeCase.create({
        data: {
          batchId,
          openedById: collectorId,
          status: 'OPENED',
          collectorStatement: reason || 'Centro de acopio de destino original no disponible o cerrado. Redirección por contingencia en ruta.',
          collectorPhotos: proofPhotoUrl ? [proofPhotoUrl] : [],
        },
      });

      return updated;
    });

    if (oldCenterId) {
      this.notificationsService
        ?.sendPushNotification(
          oldCenterId,
          'Lote redirigido a otro centro',
          `El lote ${batchId} fue desviado por el recolector debido a contingencia en ruta.`,
          { batchId },
        )
        .catch(() => {});
      this.websocketsService?.emitUserEvent(
        oldCenterId,
        'batch:updated',
        updatedBatch,
      );
    }

    this.notificationsService
      ?.sendPushNotification(
        newCenterId,
        'Nuevo lote redirigido en camino',
        `Un recolector ha redirigido un lote hacia tu centro de acopio por contingencia en ruta.`,
        { batchId },
      )
      .catch(() => {});
    this.websocketsService?.emitUserEvent(
      newCenterId,
      'batch:dispatched',
      updatedBatch,
    );
    this.websocketsService?.emitUserEvent(
      newCenterId,
      'batch:updated',
      updatedBatch,
    );
    this.websocketsService?.emitUserEvent(
      collectorId,
      'batch:updated',
      updatedBatch,
    );

    return updatedBatch;
  }
}
