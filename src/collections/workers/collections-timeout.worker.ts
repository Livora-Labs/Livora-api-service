import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestStatus } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class CollectionsTimeoutWorker {
  private readonly logger = new Logger(CollectionsTimeoutWorker.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Cron ejecutado cada minuto en livora_worker para gestionar
   * los tiempos máximos y auto-expiraciones del ciclo de recolección.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleTimeouts(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      await Promise.allSettled([
        this.processPendingTimeouts(),
        this.processAuctionFallbacks(),
        this.processAcceptedInactivity(),
        this.processArrivedNoShowTimeouts(),
      ]);
    } catch (err: any) {
      this.logger.error(`Error en ciclo de timeouts de recolección: ${err.message}`, err.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 1. PENDING TIMEOUT (30 minutos):
   * Solicitudes en bolsa pública sin asignar tras 30 min expiran a CANCELLED
   */
  private async processPendingTimeouts(): Promise<void> {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const expiredRequests = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.PENDING,
        createdAt: { lt: thirtyMinutesAgo },
      },
      select: { id: true, householdId: true },
      take: 50,
    });

    for (const req of expiredRequests) {
      try {
        await this.prisma.collectionRequest.update({
          where: { id: req.id },
          data: {
            status: RequestStatus.CANCELLED,
            rejectionReason: 'Expirada automáticamente: superó los 30 minutos sin recolector asignado.',
          },
        });

        this.notificationsService
          .sendPushNotification(
            req.householdId,
            'Solicitud expirada',
            'Tu solicitud de recolección no encontró un recolector disponible en 30 minutos. Te invitamos a volver a publicarla.',
            { requestId: req.id, status: 'CANCELLED' },
          )
          .catch(() => {});

        this.logger.log(`[TIMEOUT] Solicitud PENDING ${req.id} expirada a CANCELLED (>30m).`);
      } catch (err: any) {
        this.logger.warn(`Error al expirar solicitud PENDING ${req.id}: ${err.message}`);
      }
    }
  }

  /**
   * 2. AUCTION FALLBACK (15 minutos):
   * Subastas flash que superaron auctionExpiresAt vuelven automáticamente a PENDING
   */
  private async processAuctionFallbacks(): Promise<void> {
    const now = new Date();
    const expiredAuctions = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.AUCTION_ACTIVE,
        auctionExpiresAt: { lte: now },
      },
      include: { bids: true },
      take: 50,
    });

    for (const req of expiredAuctions) {
      try {
        const hasAcceptedBid = req.bids.some((b) => b.status === 'ACCEPTED');
        if (!hasAcceptedBid) {
          await this.prisma.acopioBid.updateMany({
            where: { requestId: req.id, status: 'PENDING' },
            data: { status: 'EXPIRED' as any },
          });

          await this.prisma.collectionRequest.update({
            where: { id: req.id },
            data: {
              status: RequestStatus.PENDING,
              assignmentMode: 'AUTOMATIC',
            },
          });

          this.notificationsService
            .sendPushNotification(
              req.householdId,
              'Subasta finalizada',
              'Tu subasta de 15 min concluyó sin ofertas aceptadas. Tu solicitud pasó a modo estándar para recolección inmediata.',
              { requestId: req.id, status: 'PENDING' },
            )
            .catch(() => {});

          this.logger.log(`[FALLBACK] Subasta ${req.id} revertida a PENDING automático.`);
        }
      } catch (err: any) {
        this.logger.warn(`Error al procesar fallback de subasta ${req.id}: ${err.message}`);
      }
    }
  }

  /**
   * 3. ACCEPTED INACTIVITY (10 minutos):
   * Si el recolector tomó la solicitud pero tras 10 min no inicia ruta (EN_ROUTE),
   * se le retira la asignación, vuelve a PENDING y se libera su garantía.
   */
  private async processAcceptedInactivity(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const inactiveRequests = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.ACCEPTED,
        enRouteAt: null,
        updatedAt: { lt: tenMinutesAgo },
      },
      select: { id: true, collectorId: true, householdId: true },
      take: 50,
    });

    for (const req of inactiveRequests) {
      try {
        await this.prisma.collectionRequest.update({
          where: { id: req.id },
          data: {
            status: RequestStatus.PENDING,
            collectorId: null,
            escrowLocked: 0,
          },
        });

        if (req.collectorId) {
          this.notificationsService
            .sendPushNotification(
              req.collectorId,
              'Asignación liberada por inactividad',
              'Superaste los 10 minutos sin iniciar ruta hacia el hogar. El pedido ha vuelto a la bolsa disponible.',
              { requestId: req.id },
            )
            .catch(() => {});
        }

        this.notificationsService
          .sendPushNotification(
            req.householdId,
            'Buscando nuevo recolector',
            'Tu recolector anterior tuvo un retraso. Tu solicitud vuelve a estar disponible para asignación prioritaria.',
            { requestId: req.id, status: 'PENDING' },
          )
          .catch(() => {});

        this.logger.log(`[INACTIVITY] Solicitud ACCEPTED ${req.id} desasignada por inactividad (>10m sin ruta).`);
      } catch (err: any) {
        this.logger.warn(`Error al desasignar solicitud ${req.id}: ${err.message}`);
      }
    }
  }

  /**
   * 4. ARRIVED NO-SHOW AUTO-TIMEOUT (10 minutos):
   * Si el recolector marcó ARRIVED y tras 10 min no se verificó PIN,
   * pasa automáticamente a UNATTENDED liberando al recolector.
   */
  private async processArrivedNoShowTimeouts(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const unverifiedArrivedRequests = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.ARRIVED,
        arrivedAt: { lt: tenMinutesAgo },
      },
      include: {
        household: true,
        collector: true,
      },
      take: 50,
    });

    for (const req of unverifiedArrivedRequests) {
      try {
        await this.prisma.collectionRequest.update({
          where: { id: req.id },
          data: {
            status: RequestStatus.UNATTENDED,
            escrowLocked: 0,
            noShowFeePen: 2.0,
          },
        });

        // Penalización de reputación al hogar (-0.5 estrellas)
        if (req.household) {
          const currentScore = req.household.reputationScore ?? 5.0;
          const newScore = Math.max(1.0, parseFloat((currentScore - 0.5).toFixed(2)));
          await this.prisma.user.update({
            where: { id: req.householdId },
            data: { reputationScore: newScore },
          }).catch(() => {});
        }

        this.notificationsService
          .sendPushNotification(
            req.householdId,
            'Visita desatendida',
            'El recolector esperó más de 10 minutos en tu domicilio. La solicitud se cerró como no atendida.',
            { requestId: req.id, status: 'UNATTENDED' },
          )
          .catch(() => {});

        if (req.collectorId) {
          this.notificationsService
            .sendPushNotification(
              req.collectorId,
              'Tiempo de espera concluido',
              'El tiempo máximo de espera concluyó. Tu garantía ha sido liberada para que continúes con tus viajes.',
              { requestId: req.id, status: 'UNATTENDED' },
            )
            .catch(() => {});
        }

        this.logger.log(`[AUTO-UNATTENDED] Solicitud ARRIVED ${req.id} cerrada por inasistencia (>10m en puerta).`);
      } catch (err: any) {
        this.logger.warn(`Error al auto-cerrar solicitud ARRIVED ${req.id}: ${err.message}`);
      }
    }
  }
}
