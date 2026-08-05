import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const sortOrder = (query.sortOrder || 'DESC').toLowerCase() as 'asc' | 'desc';

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
      throw new ForbiddenException('No tienes permisos para modificar esta notificación');
    }

    return this.prisma.notification.update({
      where: { id },
      data: {
        isRead: dto.isRead,
      },
    });
  }
}
