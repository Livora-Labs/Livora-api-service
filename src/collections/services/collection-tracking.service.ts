import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { RequestStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WebsocketsService } from '../../websockets/websockets.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { CollectorTelemetryDto } from '../dto/collector-telemetry.dto';
import { GeoUtil } from '../../common/utils/geo.util';

/**
 * Servicio de Telemetría y Seguimiento GPS (PUCP Disoft - Single Responsibility & Anti-Cut&Paste)
 * Gestiona el ciclo vehicular de recolección (EN_ROUTE, ARRIVED, telemetría OSRM/Haversine y WebSockets).
 */
@Injectable()
export class CollectionTrackingService {
  private readonly logger = new Logger(CollectionTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly websocketsService: WebsocketsService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  private stripPin<T extends Record<string, any>>(row: T): T {
    if (!row) return row;
    const { verificationPin, ...safe } = row;
    return safe as T;
  }

  /**
   * Inicia el trayecto vehicular hacia el domicilio (ACCEPTED -> EN_ROUTE)
   */
  async startRoute(id: string, collectorId: string) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true } },
        collector: {
          select: { id: true, name: true, phone: true, profilePhotoUrl: true },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.collectorId !== collectorId) {
      throw new ForbiddenException('Solo el recolector asignado puede iniciar la ruta');
    }

    if (request.status === RequestStatus.EN_ROUTE) {
      return this.stripPin(request);
    }

    if (request.status !== RequestStatus.ACCEPTED) {
      throw new BadRequestException(
        `Solo solicitudes en estado ACCEPTED pueden iniciar ruta (Estado actual: ${request.status})`,
      );
    }

    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        status: RequestStatus.EN_ROUTE,
        enRouteAt: new Date(),
      },
      include: {
        household: {
          select: { id: true, email: true, name: true, address: true },
        },
        collector: {
          select: { id: true, name: true, phone: true, profilePhotoUrl: true },
        },
        assignedCenter: {
          select: { id: true, name: true, email: true, address: true },
        },
      },
    });

    if (this.redisService) {
      const kyc = await this.prisma.kycApplication.findFirst({
        where: { userId: updated.collectorId! },
        select: { transportType: true },
        orderBy: { createdAt: 'desc' },
      });
      const meta = {
        id: updated.id,
        collectorId: updated.collectorId,
        householdId: updated.householdId,
        latitude: updated.latitude,
        longitude: updated.longitude,
        transportType: kyc?.transportType || 'MOTO_CARGA',
      };
      await this.redisService
        .set(`collection:active:${id}`, JSON.stringify(meta), 3600)
        .catch(() => {});
    }

    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Recolector en camino',
        `${request.collector?.name || 'Tu recolector'} ha iniciado el viaje hacia tu dirección. Ten listos tus materiales reciclables.`,
        { requestId: id, status: 'EN_ROUTE' },
      )
      .catch(() => {});

    this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
    return this.stripPin(updated);
  }

  /**
   * Marca llegada al domicilio e inicia ventana de espera (EN_ROUTE -> ARRIVED)
   */
  async reachDestination(id: string, collectorId: string) {
    const request = await this.prisma.collectionRequest.findUnique({
      where: { id },
      include: {
        household: { select: { id: true, email: true, name: true } },
        collector: { select: { id: true, name: true } },
      },
    });

    if (!request) {
      throw new NotFoundException('Solicitud de recolección no encontrada');
    }

    if (request.collectorId !== collectorId) {
      throw new ForbiddenException('Solo el recolector asignado puede marcar su llegada');
    }

    if (request.status !== RequestStatus.EN_ROUTE) {
      if (request.status === RequestStatus.ARRIVED) {
        return this.stripPin(request);
      }
      throw new BadRequestException(
        `Solo solicitudes en estado EN_ROUTE pueden marcar llegada (Estado actual: ${request.status})`,
      );
    }

    const updated = await this.prisma.collectionRequest.update({
      where: { id },
      data: {
        status: RequestStatus.ARRIVED,
        arrivedAt: new Date(),
      },
      include: {
        household: {
          select: { id: true, email: true, name: true, address: true },
        },
        collector: {
          select: { id: true, name: true, phone: true, profilePhotoUrl: true },
        },
        assignedCenter: {
          select: { id: true, name: true, email: true, address: true },
        },
      },
    });

    this.notificationsService
      .sendPushNotification(
        request.householdId,
        'Recolector en puerta',
        'El recolector ha llegado a tu domicilio. Acércate con tus materiales y tu PIN de 4 dígitos.',
        {
          type: 'HOGAR_COLLECTOR_ARRIVED',
          requestId: id,
          status: 'ARRIVED',
          channelId: 'livora_collections_urgent',
          requiresInAppModal: 'true',
        },
      )
      .catch(() => {});

    if (this.redisService) {
      await Promise.all([
        this.redisService.del(`collection:active:${id}`).catch(() => {}),
        this.redisService.del(`collector:loc:${id}`).catch(() => {}),
        this.redisService.del(`route:collection:${id}`).catch(() => {}),
      ]);
    }

    this.websocketsService.emitUserEvent(request.householdId, 'collector:arrived', {
      requestId: id,
      status: RequestStatus.ARRIVED,
      timestamp: Date.now(),
    });

    this.websocketsService.emitCollectionUpdated(this.stripPin(updated));
    return this.stripPin(updated);
  }

  /**
   * Procesa telemetría GPS periódica y retransmite vía WebSockets al Hogar
   */
  async updateCollectorLocation(
    id: string,
    collectorId: string,
    dto: CollectorTelemetryDto,
  ) {
    let meta: {
      id: string;
      collectorId: string;
      householdId: string;
      latitude: number;
      longitude: number;
      transportType: string;
    } | null = null;

    if (this.redisService) {
      const cached = await this.redisService
        .get(`collection:active:${id}`)
        .catch(() => null);
      if (cached) {
        try {
          meta = JSON.parse(cached);
        } catch {
          meta = null;
        }
      }
    }

    if (!meta) {
      const dbReq = await this.prisma.collectionRequest.findUnique({
        where: { id },
        select: {
          id: true,
          collectorId: true,
          householdId: true,
          latitude: true,
          longitude: true,
          status: true,
        },
      });

      if (!dbReq) {
        throw new NotFoundException('Solicitud de recolección no encontrada');
      }

      if (dbReq.collectorId !== collectorId) {
        throw new ForbiddenException(
          'Solo el recolector asignado puede enviar coordenadas para esta solicitud',
        );
      }

      if (dbReq.status !== RequestStatus.EN_ROUTE) {
        throw new BadRequestException(
          `Solo solicitudes en estado EN_ROUTE aceptan telemetría (Estado actual: ${dbReq.status})`,
        );
      }

      const kyc = await this.prisma.kycApplication.findFirst({
        where: { userId: collectorId },
        select: { transportType: true },
        orderBy: { createdAt: 'desc' },
      });

      meta = {
        id: dbReq.id,
        collectorId: dbReq.collectorId,
        householdId: dbReq.householdId,
        latitude: dbReq.latitude,
        longitude: dbReq.longitude,
        transportType: kyc?.transportType || 'MOTO_CARGA',
      };

      if (this.redisService) {
        await this.redisService
          .set(`collection:active:${id}`, JSON.stringify(meta), 3600)
          .catch(() => {});
      }
    } else {
      if (meta.collectorId !== collectorId) {
        throw new ForbiddenException(
          'Solo el recolector asignado puede enviar coordenadas para esta solicitud',
        );
      }
    }

    const { latitude, longitude, heading = 0, speed = 0 } = dto;

    // Cálculo unificado Haversine (Anti-Cut&Paste via GeoUtil)
    const distKm = GeoUtil.calculateHaversineKm(
      latitude,
      longitude,
      meta.latitude,
      meta.longitude,
    );
    const fallbackDistMeters = Math.round(distKm * 1000);

    const distanceRemainingMeters =
      typeof dto.distanceRemainingMeters === 'number' &&
      dto.distanceRemainingMeters >= 0
        ? Math.round(dto.distanceRemainingMeters)
        : fallbackDistMeters;

    const transportType = dto.transportType || meta.transportType || 'MOTO_CARGA';
    let defaultSpeed = 20;
    switch (transportType) {
      case 'A_PIE':
        defaultSpeed = 4.2;
        break;
      case 'TRICICLO':
        defaultSpeed = 11;
        break;
      case 'BICICLETA':
        defaultSpeed = 15;
        break;
      case 'MOTO_CARGA':
        defaultSpeed = 24;
        break;
      case 'CAMIONETA':
        defaultSpeed = 30;
        break;
      default:
        defaultSpeed = 20;
    }

    const effectiveSpeedKmh =
      speed > 3 ? Math.min(speed, defaultSpeed * 1.5) : defaultSpeed;
    const fallbackEta = Math.max(
      1,
      Math.round((distanceRemainingMeters / 1000 / effectiveSpeedKmh) * 60),
    );

    const etaMinutes =
      typeof dto.etaMinutes === 'number' && dto.etaMinutes > 0
        ? dto.etaMinutes
        : fallbackEta;

    const socketPayload = {
      requestId: id,
      collectorId,
      transportType,
      latitude,
      longitude,
      heading,
      speed,
      distanceRemainingMeters,
      etaMinutes,
      timestamp: dto.timestamp || Date.now(),
    };

    if (this.redisService) {
      await this.redisService
        .set(`collector:loc:${id}`, JSON.stringify(socketPayload), 1800)
        .catch(() => {});
    }

    // Retransmisión cerrada y segura a la sala privada user:<householdId>
    this.websocketsService.emitUserEvent(
      meta.householdId,
      'collector:location',
      socketPayload,
    );

    return socketPayload;
  }
}
