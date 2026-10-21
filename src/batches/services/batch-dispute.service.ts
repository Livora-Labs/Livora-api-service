import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { DisputeBatchDto } from '../dto/dispute-batch.dto';
import { BatchStateMachine } from '../states/batch-state-machine';

/**
 * Servicio de Disputas y Arbitraje B2B (PUCP Disoft - SRP & Estado de Dominio)
 * Aísla las controversias de inventario industrial entre recolectores y centros de acopio,
 * garantizando la trazabilidad probatoria y la neutralidad del Libro de Reclamaciones B2C.
 */
@Injectable()
export class BatchDisputeService {
  private readonly logger = new Logger(BatchDisputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
  ) {}

  /**
   * POST /batches/:id/dispute (Rol: RECOLECTOR)
   * Impugna un lote observado por discrepancias (FLAGGED_FOR_REVIEW) y lo congela (DISPUTED).
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

    BatchStateMachine.validateTransition(batch.status, 'DISPUTED' as any);

    const updated = await this.prisma.batch.update({
      where: { id: batchId },
      data: {
        status: 'DISPUTED' as any,
        discrepancyNote: `[DISPUTA B2B ABIERTA POR RECOLECTOR] Motivo: ${dto.reason}`,
      },
      include: {
        collector: { select: { id: true, name: true, email: true } },
        destinationCenter: { select: { id: true, name: true, email: true } },
      },
    });

    this.notificationsService
      ?.sendPushNotification(
        batch.destinationCenterId || '',
        'Lote impugnado por recolector',
        `El recolector ha iniciado una controversia formal B2B sobre el pesaje del lote ${batchId}. Estado congelado en DISPUTED.`,
        { batchId, status: 'DISPUTED' },
      )
      .catch(() => {});

    this.websocketsService?.emitUserEvent(
      batch.destinationCenterId || '',
      'batch:updated',
      updated,
    );
    this.websocketsService?.emitUserEvent(
      collectorUserId,
      'batch:updated',
      updated,
    );

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
