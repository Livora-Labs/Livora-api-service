import { Batch, BatchStatus } from '@prisma/client';

/**
 * Patrón Repositorio / Data Mapper (PUCP Disoft Diapositivas 08 y 09)
 * Abstrae las operaciones de persistencia del agregado Batch sobre Prisma ORM.
 */
export interface IBatchesRepository {
  findById(id: string): Promise<Batch | null>;
  findByIdWithDetails(id: string): Promise<any | null>;
  findOpenBatch(collectorId: string, centerId?: string): Promise<any | null>;
  createOpenBatch(collectorId: string, destinationCenterId: string): Promise<Batch>;
  updateStatus(id: string, status: BatchStatus): Promise<Batch>;
  update(id: string, data: any): Promise<Batch>;
}
