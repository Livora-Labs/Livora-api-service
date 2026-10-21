import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User, ConsentAudit } from '@prisma/client';
import { IUsersRepository } from './users.repository.interface';

/**
 * Implementación Concreta de Repositorio de Usuarios (PUCP Disoft - Data Mapper Pattern)
 * Centraliza la persistencia de usuarios en PostgreSQL vía Prisma.
 */
@Injectable()
export class UsersRepository implements IUsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async create(data: any): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async update(id: string, data: any): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async updateFcmToken(id: string, fcmToken: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { fcmToken },
    });
  }

  async getConsentAudits(userId: string): Promise<ConsentAudit[]> {
    return this.prisma.consentAudit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
