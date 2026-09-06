import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, App, cert } from 'firebase-admin';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private firebaseApp: App | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
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
   * Envía una notificación Push FCM y la guarda en la base de datos
   */
  async sendPushNotification(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          title,
          message: body,
          isRead: false,
        },
      });
    } catch (err: any) {
      this.logger.error(
        `Error guardando notificación en la base de datos: ${err.message}`,
      );
    }

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

    // Despachar a cada token registrado
    for (const token of allTokens) {
      try {
        await getMessaging(this.firebaseApp).send({
          token,
          notification: { title, body },
          data,
        });
        this.logger.log(
          `Notificación Push FCM enviada con éxito al dispositivo (${token.substring(0, 10)}...) del usuario ${userId}`,
        );
      } catch (err: any) {
        this.logger.error(
          `Error enviando notificación Push a ${userId} en token ${token}: ${err.message}`,
        );
        // Limpieza automática de tokens desregistrados / inválidos
        if (
          err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token' ||
          err.message?.includes('not registered')
        ) {
          this.logger.warn(
            `Eliminando DeviceToken obsoleto/inválido: ${token}`,
          );
          await this.prisma.deviceToken
            .deleteMany({ where: { token } })
            .catch(() => {});
          if (user?.fcmToken === token) {
            await this.prisma.user
              .update({ where: { id: userId }, data: { fcmToken: null } })
              .catch(() => {});
          }
        }
      }
    }
  }
}
