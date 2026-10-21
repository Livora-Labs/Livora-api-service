import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';

/**
 * Servicio de Liquidación Fiduciaria y Cierre Contable (PUCP Disoft - SRP)
 * Asienta la contabilidad dual (fiat vs eco-tokens) para el intercambio de materiales físicos.
 */
@Injectable()
export class BatchSettlementService {
  private readonly logger = new Logger(BatchSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly websocketsService?: WebsocketsService,
  ) {}

  /**
   * POST /batches/:id/fiat-settlement (Rol: CENTRO_ACOPIO)
   * Asienta contablemente la entrega de efectivo (Soles) por el material físico recibido.
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

    this.notificationsService
      ?.sendPushNotification(
        batch.collectorId,
        'Pago fiduciario registrado',
        'El Centro de Acopio ha asentado contablemente la entrega de tu pago en efectivo por el lote entregado.',
        { batchId, fiatSettled: 'true' },
      )
      .catch(() => {});

    this.websocketsService?.emitUserEvent(
      batch.collectorId,
      'batch:fiat-settled',
      { batchId: updated.id, fiatSettled: true },
    );
    this.websocketsService?.emitUserEvent(
      batch.collectorId,
      'batch:updated',
      updated,
    );
    this.websocketsService?.emitUserEvent(
      centerUserId,
      'batch:updated',
      updated,
    );

    return {
      message: 'Pago fiat registrado exitosamente',
      batchId: updated.id,
      fiatSettled: updated.fiatSettled,
      fiatSettledAt: updated.fiatSettledAt,
    };
  }
}
