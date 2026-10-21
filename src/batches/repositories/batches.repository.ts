import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Batch, BatchStatus } from '@prisma/client';
import { IBatchesRepository } from './batches.repository.interface';

/**
 * Implementación Concreta de Repositorio de Lotes (PUCP Disoft - Data Mapper Pattern)
 * Centraliza las consultas, inclusiones relacionales y transacciones de persistencia para lotes.
 */
@Injectable()
export class BatchesRepository implements IBatchesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Batch | null> {
    return this.prisma.batch.findUnique({
      where: { id },
    });
  }

  async findByIdWithDetails(id: string): Promise<any | null> {
    return this.prisma.batch.findUnique({
      where: { id },
      include: {
        collector: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            walletAddress: true,
          },
        },
        destinationCenter: {
          select: {
            id: true,
            name: true,
            email: true,
            address: true,
            walletAddress: true,
          },
        },
        requests: {
          include: {
            household: {
              select: {
                id: true,
                name: true,
                address: true,
              },
            },
          },
        },
        disputes: true,
        consolidatedBatch: true,
      },
    });
  }

  async findOpenBatch(collectorId: string, centerId?: string): Promise<any | null> {
    return this.prisma.batch.findFirst({
      where: {
        collectorId,
        ...(centerId ? { destinationCenterId: centerId } : {}),
        status: BatchStatus.OPEN,
      },
      include: {
        requests: true,
        destinationCenter: {
          select: {
            id: true,
            name: true,
            address: true,
          },
        },
      },
    });
  }

  async createOpenBatch(
    collectorId: string,
    destinationCenterId: string,
  ): Promise<Batch> {
    return this.prisma.batch.create({
      data: {
        collectorId,
        destinationCenterId,
        status: BatchStatus.OPEN,
      },
    });
  }

  async updateStatus(id: string, status: BatchStatus): Promise<Batch> {
    return this.prisma.batch.update({
      where: { id },
      data: { status },
    });
  }

  async update(id: string, data: any): Promise<Batch> {
    return this.prisma.batch.update({
      where: { id },
      data,
    });
  }
}
