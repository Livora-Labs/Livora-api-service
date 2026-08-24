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

    if (projectId && clientEmail && privateKey) {
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
        this.logger.error(
          `Error inicializando Firebase Admin SDK: ${err.message}`,
        );
      }
    } else {
      this.logger.warn(
        'Variables de entorno de Firebase incompletas. Las notificaciones Push FCM se imprimirán en consola.',
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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });

    if (!user?.fcmToken) {
      this.logger.log(
        `[FCM Simulación] El usuario ${userId} no tiene FCM Token. Notificación: "${title}" - "${body}"`,
      );
      return;
    }

    if (!this.firebaseApp) {
      this.logger.log(
        `[FCM Simulación] Para token ${user.fcmToken} | Título: "${title}" | Mensaje: "${body}"`,
      );
      return;
    }

    try {
      await getMessaging(this.firebaseApp).send({
        token: user.fcmToken,
        notification: { title, body },
        data,
      });
      this.logger.log(
        `Notificación Push FCM enviada con éxito al usuario ${userId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Error enviando notificación Push a ${userId}: ${err.message}`,
      );
    }
  }
}
