import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { RequestStatus } from '@prisma/client';
import { SubmitBidDto } from '../dto/submit-bid.dto';
import { SelectBidDto } from '../dto/select-bid.dto';

@Injectable()
export class CollectionAuctionService {
  private readonly logger = new Logger(CollectionAuctionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly websocketsService: WebsocketsService,
  ) {}

  private stripPin(request: any) {
    if (!request) return request;
    const { receptionPin, ...safe } = request;
    return safe;
  }

  /**
   * Centro de Acopio envía una propuesta económica (bid) a una solicitud (Rol: CENTRO_ACOPIO)
   */
  async submitBid(centerId: string, requestId: string, dto: SubmitBidDto) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id: requestId },
      include: { household: { select: { id: true, email: true, name: true } } },
    });

    if (!request) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    if (
      request.status !== RequestStatus.PENDING &&
      request.status !== RequestStatus.AUCTION_ACTIVE
    ) {
      throw new BadRequestException(
        'Solo se pueden enviar propuestas a solicitudes en estado PENDING o AUCTION_ACTIVE',
      );
    }

    if (request.assignmentMode !== 'AUCTION') {
      throw new BadRequestException('La solicitud no está configurada en modo AUCTION');
    }

    if (request.auctionExpiresAt && new Date() > request.auctionExpiresAt) {
      throw new BadRequestException('El tiempo de la subasta de 15 minutos ha expirado');
    }

    const proposedRates: Record<string, number> = {};
    if (dto.proposedRates && typeof dto.proposedRates === 'object') {
      for (const [mat, rate] of Object.entries(dto.proposedRates)) {
        const r = Number(rate);
        if (isNaN(r) || r < 0.05) {
          throw new BadRequestException(`La tarifa propuesta para ${mat} debe ser de al menos 0.05 PEN`);
        }
        const parts = r.toString().split('.');
        if (parts.length > 1 && parts[1].length > 2) {
          throw new BadRequestException(`La tarifa propuesta para ${mat} no puede tener más de 2 decimales`);
        }
        proposedRates[mat] = r;
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

    // Calcular montos estimados: total PEN y total EcoTokens para el Hogar (25%)
    let totalEstimatedPenn = 0;
    const items = (request.itemsEstimated as Record<string, number>) || {};
    for (const [mat, weightRaw] of Object.entries(items)) {
      const weight = typeof weightRaw === 'number' ? weightRaw : parseFloat(String(weightRaw)) || 0;
      const rate = proposedRates[mat] || proposedRates[mat.toUpperCase()] || 0;
      totalEstimatedPenn += weight * rate;
    }

    const totalEstimatedEco = parseFloat((totalEstimatedPenn * 0.25).toFixed(2));
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
        `Un centro de acopio ha ofertado S/ ${totalEstimatedPenn.toFixed(2)} PEN (${totalEstimatedEco.toFixed(2)} LIVOs) por tu material.`,
        { requestId, bidId: bid.id },
      )
      .catch(() => {});

    // Notificación en tiempo real directa al hogar
    this.websocketsService.emitUserEvent(
      request.householdId,
      'auction:bid',
      {
        requestId,
        bidId: bid.id,
        centerId: bid.centerId,
        centerName: (bid as any).center?.name || 'Centro de Acopio',
        totalEstimatedPenn,
        totalEstimatedLivo: totalEstimatedEco,
        proposedRates,
        timestamp: Date.now(),
      },
    );

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

    if (
      request.status !== RequestStatus.PENDING &&
      request.status !== RequestStatus.AUCTION_ACTIVE
    ) {
      throw new BadRequestException('La solicitud ya no se encuentra en estado PENDING ni AUCTION_ACTIVE');
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
      const currentReq = await tx.collectionRequest.findUnique({
        where: { id: requestId },
      });
      if (
        !currentReq ||
        (currentReq.status !== RequestStatus.PENDING &&
          currentReq.status !== RequestStatus.AUCTION_ACTIVE)
      ) {
        throw new BadRequestException('La solicitud ya no se encuentra disponible para subasta');
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
          status: RequestStatus.AUCTION_ASSIGNED,
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

    // Notificar a recolectores y partes interesadas vía WebSockets
    this.websocketsService.emitCollectionCreated(this.stripPin(updatedRequest));
    this.websocketsService.emitCollectionUpdated(this.stripPin(updatedRequest));

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
        'Un centro de acopio ha aceptado tu solicitud de recolección en modo automático.',
        { requestId },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionUpdated(this.stripPin(updatedRequest));
    return updatedRequest;
  }

  /**
   * Fallback de Subastas Flash de 15 minutos:
   * Convierte automáticamente solicitudes en AUCTION_ACTIVE expiradas a PENDING (Modo Automático).
   */
  async checkAuctionFallbacks() {
    const now = new Date();
    const expiredAuctions = await this.prisma.collectionRequest.findMany({
      where: {
        status: RequestStatus.AUCTION_ACTIVE,
        auctionExpiresAt: { lte: now },
      },
      include: { bids: true },
    });

    for (const req of expiredAuctions) {
      const hasAcceptedBid = req.bids.some((b) => b.status === 'ACCEPTED');
      if (!hasAcceptedBid) {
        await this.prisma.acopioBid.updateMany({
          where: { requestId: req.id, status: 'PENDING' },
          data: { status: 'EXPIRED' as any },
        });

        const updated = await this.prisma.collectionRequest.update({
          where: { id: req.id },
          data: {
            status: RequestStatus.PENDING,
            assignmentMode: 'AUTOMATIC',
          },
        });

        this.notificationsService
          .sendPushNotification(
            req.householdId,
            'Subasta finalizada sin ganador',
            'Tu subasta de 15 minutos concluyó. Tu solicitud ha pasado automáticamente a modo estándar para recolección inmediata.',
            { requestId: req.id },
          )
          .catch(() => {});

        this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
      }
    }
  }
}
