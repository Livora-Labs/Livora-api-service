import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { PushNotificationProcessor } from './push-notification.processor';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { getQueueToken } from '@nestjs/bullmq';
import { PUSH_NOTIFICATIONS_QUEUE } from './notifications.constants';

describe('NotificationsService & PushNotificationProcessor', () => {
  let service: NotificationsService;
  let processor: PushNotificationProcessor;
  let prisma: any;
  let configService: any;
  let mockQueue: any;
  let websocketsService: any;

  beforeEach(async () => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({
          id: 'notif-1',
          userId: 'user-123',
          title: 'Prueba',
          message: 'Cuerpo de prueba',
          createdAt: new Date(),
        }),
      },
      deviceToken: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ fcmToken: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'FIREBASE_PROJECT_ID') return undefined; // No real firebase init in test
        return undefined;
      }),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    websocketsService = {
      emitUserEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        PushNotificationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        { provide: WebsocketsService, useValue: websocketsService },
        { provide: getQueueToken(PUSH_NOTIFICATIONS_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    processor = module.get<PushNotificationProcessor>(PushNotificationProcessor);
  });

  describe('sendPushNotification', () => {
    it('debe persistir en BD y encolar en BullMQ de forma no bloqueante', async () => {
      await service.sendPushNotification(
        'user-123',
        '¡Recolector Asignado!',
        'El recolector Carlos está en camino.',
        { requestId: 'req-456' },
      );

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          title: '¡Recolector Asignado!',
          message: 'El recolector Carlos está en camino.',
        }),
      });

      expect(mockQueue.add).toHaveBeenCalledWith('send-user-push', {
        type: 'user',
        userId: 'user-123',
        title: '¡Recolector Asignado!',
        body: 'El recolector Carlos está en camino.',
        data: { requestId: 'req-456' },
      });
    });

    it('debe ejecutar fallback directo si la cola BullMQ falla', async () => {
      mockQueue.add.mockRejectedValueOnce(new Error('Redis connection down'));
      const executeSpy = jest.spyOn(service, 'executePushNotification').mockResolvedValueOnce();

      await service.sendPushNotification('user-123', 'Alerta', 'Mensaje directo');

      expect(executeSpy).toHaveBeenCalledWith('user-123', 'Alerta', 'Mensaje directo', undefined);
    });
  });

  describe('sendTopicNotification', () => {
    it('debe encolar correctamente la notificación al tópico en BullMQ', async () => {
      await service.sendTopicNotification(
        'zone_lima',
        'Nueva Solicitud en Zona',
        'Hay material reciclable disponible en Miraflores',
        { channelId: 'livora_collections_urgent' },
      );

      expect(mockQueue.add).toHaveBeenCalledWith('send-topic-push', {
        type: 'topic',
        topic: 'zone_lima',
        title: 'Nueva Solicitud en Zona',
        body: 'Hay material reciclable disponible en Miraflores',
        data: { channelId: 'livora_collections_urgent' },
      });
    });
  });

  describe('PushNotificationProcessor', () => {
    it('debe procesar un job de tipo user invocando executePushNotification', async () => {
      const executeSpy = jest.spyOn(service, 'executePushNotification').mockResolvedValueOnce();

      await processor.process({
        data: {
          type: 'user',
          userId: 'user-123',
          title: 'Notificación Worker',
          body: 'Cuerpo procesado por BullMQ',
          data: { type: 'test' },
        },
      } as any);

      expect(executeSpy).toHaveBeenCalledWith(
        'user-123',
        'Notificación Worker',
        'Cuerpo procesado por BullMQ',
        { type: 'test' },
      );
    });

    it('debe procesar un job de tipo topic invocando executeTopicNotification', async () => {
      const topicSpy = jest.spyOn(service, 'executeTopicNotification').mockResolvedValueOnce();

      await processor.process({
        data: {
          type: 'topic',
          topic: 'role_recolector',
          title: 'Alerta Recolectores',
          body: 'Nueva bonificación por volumen',
        },
      } as any);

      expect(topicSpy).toHaveBeenCalledWith(
        'role_recolector',
        'Alerta Recolectores',
        'Nueva bonificación por volumen',
        undefined,
      );
    });
  });

  describe('executePushNotification (Multicast & Token Management)', () => {
    it('debe registrar simulación sin fallar si el usuario no tiene tokens', async () => {
      prisma.deviceToken.findMany.mockResolvedValueOnce([]);
      prisma.user.findUnique.mockResolvedValueOnce({ fcmToken: null });

      await expect(
        service.executePushNotification('user-sin-tokens', 'Aviso', 'Sin dispositivos'),
      ).resolves.not.toThrow();
    });
  });
});
