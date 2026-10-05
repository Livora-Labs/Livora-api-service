import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, App, cert } from 'firebase-admin';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { WebsocketsService } from '../websockets/websockets.service';

import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PUSH_NOTIFICATIONS_QUEUE } from './notifications.constants';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseApp: App | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly websocketsService?: WebsocketsService,
    @Optional()
    @InjectQueue(PUSH_NOTIFICATIONS_QUEUE)
    private readonly pushQueue?: Queue,
  ) {
    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    const isPlaceholderKey =
      !privateKey ||
      privateKey.includes('...') ||
      privateKey.includes('your_');

    if (projectId && clientEmail && privateKey && !isPlaceholderKey) {
      try {
        this.firebaseApp = initializeApp(
          {
            credential: cert({
              projectId,
              clientEmail,
              privateKey: privateKey.replace(/\\n/g, '\n'),
            }),
          },
          'livora-fcm',
        );
        this.logger.log('Firebase Admin SDK inicializado para FCM');
      } catch (err: any) {
        this.logger.warn(
          `Firebase Admin SDK no pudo inicializarse (${err.message}). Las notificaciones Push FCM se imprimirán en consola.`,
        );
      }
    } else {
      this.logger.warn(
        'Variables de entorno de Firebase no configuradas o con credenciales de prueba. Las notificaciones Push FCM se imprimirán en consola.',
      );
    }
  }

  /**
   * GET /notifications
   * Devuelve notificaciones del usuario autenticado de forma paginada
   */
  async findAll(userId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const allowedSortFields = ['createdAt', 'isRead'];
    const sanitizedSortBy = allowedSortFields.includes(query.sortBy || '')
      ? query.sortBy!
      : 'createdAt';
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as
      'asc' | 'desc';

    return this.prisma.notification.findMany({
      where: { userId },
      skip,
      take: limit,
      orderBy: { [sanitizedSortBy]: sortOrder },
    });
  }

  /**
   * PATCH /notifications/:id
   * Actualiza el estado de lectura (isRead) de una notificación
   */
  async updateStatus(id: string, userId: string, dto: UpdateNotificationDto) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      throw new NotFoundException('Notificación no encontrada');
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException(
        'No tienes permisos para modificar esta notificación',
      );
    }

    return this.prisma.notification.update({
      where: { id },
      data: {
        isRead: dto.isRead,
      },
    });
  }

  /**
   * PATCH /notifications/mark-all-read
   * Marca atómicamente todas las notificaciones no leídas del usuario como leídas
   */
  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    return {
      success: true,
      count: result.count,
    };
  }

  /**
   * Envía una notificación Push FCM y la guarda en la base de datos
   */
  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    try {
      const created = await this.prisma.notification.create({
        data: {
          userId,
          title,
          message: body,
          isRead: false,
        },
      });

      // Emite evento en tiempo real por WebSocket al canal privado user:${userId}
      this.websocketsService?.emitUserEvent(userId, 'notification:created', {
        id: created.id,
        title: created.title,
        message: created.message,
        createdAt: created.createdAt,
        isRead: false,
        data: data || {},
      });
    } catch (err: any) {
      this.logger.error(
        `Error guardando notificación en la base de datos: ${err.message}`,
      );
    }

    // Desacoplamiento asíncrono con BullMQ: respuesta inmediata en API (<15ms)
    if (this.pushQueue) {
      try {
        await this.pushQueue.add('send-user-push', {
          type: 'user',
          userId,
          title,
          body,
          data,
        });
        return;
      } catch (err: any) {
        this.logger.warn(
          `Error encolando push en BullMQ (${err.message}). Conmutando a despacho directo.`,
        );
      }
    }

    await this.executePushNotification(userId, title, body, data);
  }

  /**
   * Encola o despacha una notificación a un tópico FCM (ej: zone_lima, role_recolector)
   */
  async sendTopicNotification(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    if (this.pushQueue) {
      try {
        await this.pushQueue.add('send-topic-push', {
          type: 'topic',
          topic,
          title,
          body,
          data,
        });
        return;
      } catch (err: any) {
        this.logger.warn(
          `Error encolando topic push en BullMQ (${err.message}). Conmutando a despacho directo.`,
        );
      }
    }

    await this.executeTopicNotification(topic, title, body, data);
  }

  /**
   * Ejecución real de despacho FCM a tokens de usuario (invocado por el Worker BullMQ o en fallback)
   */
  async executePushNotification(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    // Consultar todos los tokens de dispositivo registrados para el usuario
    const deviceTokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { id: true, token: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });

    const allTokens = new Set<string>();
    if (user?.fcmToken) allTokens.add(user.fcmToken);
    for (const dt of deviceTokens) {
      if (dt.token) allTokens.add(dt.token);
    }

    if (allTokens.size === 0) {
      this.logger.log(
        `[FCM Simulación] El usuario ${userId} no tiene DeviceTokens registrados. Notificación: "${title}" - "${body}"`,
      );
      return;
    }

    if (!this.firebaseApp) {
      this.logger.log(
        `[FCM Simulación] (${allTokens.size} dispositivos) | Título: "${title}" | Mensaje: "${body}"`,
      );
      return;
    }

    const tokenArray = Array.from(allTokens);
    const channelId = data?.channelId || 'livora_collections_urgent';
    const sound =
      data?.sound ||
      (channelId === 'livora_wallet_ledger'
        ? 'transaction_tone.mp3'
        : channelId === 'livora_collections_urgent'
          ? 'alert_tone.mp3'
          : 'default');

    // Despacho masivo optimizado mediante sendEachForMulticast en lotes de 500
    const chunkSize = 500;
    for (let i = 0; i < tokenArray.length; i += chunkSize) {
      const chunk = tokenArray.slice(i, i + chunkSize);
      try {
        const response = await getMessaging(this.firebaseApp).sendEachForMulticast({
          tokens: chunk,
          notification: { title, body },
          data: data || {},
          android: {
            priority: 'high',
            notification: {
              channelId,
              sound,
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            payload: {
              aps: {
                sound,
                category: data?.type || 'LIVORA_NOTIFICATION',
              },
            },
          },
        });

        this.logger.log(
          `[FCM Multicast] Éxito: ${response.successCount}, Fallos: ${response.failureCount} para usuario ${userId}`,
        );

        // Limpieza reactiva de tokens inválidos o desinstalados
        if (response.failureCount > 0) {
          const tokensToDelete: string[] = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error) {
              const errCode = resp.error.code;
              if (
                errCode === 'messaging/registration-token-not-registered' ||
                errCode === 'messaging/invalid-registration-token' ||
                resp.error.message?.includes('not registered')
              ) {
                tokensToDelete.push(chunk[idx]);
              }
            }
          });

          if (tokensToDelete.length > 0) {
            this.logger.warn(`Eliminando ${tokensToDelete.length} tokens FCM obsoletos`);
            await this.prisma.deviceToken
              .deleteMany({ where: { token: { in: tokensToDelete } } })
              .catch(() => {});
            if (user?.fcmToken && tokensToDelete.includes(user.fcmToken)) {
              await this.prisma.user
                .update({ where: { id: userId }, data: { fcmToken: null } })
                .catch(() => {});
            }
          }
        }
      } catch (err: any) {
        this.logger.error(`Error en sendEachForMulticast para usuario ${userId}: ${err.message}`);
      }
    }
  }

  /**
   * Ejecución real de despacho a tópico FCM (invocado por el Worker BullMQ o en fallback)
   */
  async executeTopicNotification(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    const cleanTopic = topic.replace(/[^a-zA-Z0-9-_.~%]/g, '_');
    if (!this.firebaseApp) {
      this.logger.log(
        `[FCM Simulación Tópico: ${cleanTopic}] Título: "${title}" | Mensaje: "${body}"`,
      );
      return;
    }

    try {
      const channelId = data?.channelId || 'livora_collections_urgent';
      const sound =
        data?.sound ||
        (channelId === 'livora_wallet_ledger'
          ? 'transaction_tone.mp3'
          : channelId === 'livora_collections_urgent'
            ? 'alert_tone.mp3'
            : 'default');

      await getMessaging(this.firebaseApp).send({
        topic: cleanTopic,
        notification: { title, body },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            channelId,
            sound,
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        apns: {
          payload: {
            aps: {
              sound,
              category: data?.type || 'LIVORA_NOTIFICATION',
            },
          },
        },
      });

      this.logger.log(`Notificación emitida al tópico FCM [${cleanTopic}]: "${title}"`);
    } catch (err: any) {
      this.logger.error(`Error enviando notificación al tópico FCM ${cleanTopic}: ${err.message}`);
    }
  }
}

