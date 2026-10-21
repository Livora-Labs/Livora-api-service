import { CollectionRequest, Role } from '@prisma/client';
import { FindCollectionsQueryDto } from '../dto/find-collections-query.dto';
import { AvailableCollectionsQueryDto } from '../dto/available-collections-query.dto';
import { PaginatedResultDto } from '../../common/dto/paginated-result.dto';

/**
 * Patrón Repositorio / Data Mapper (PUCP Disoft Diapositivas 08 y 09)
 * Aísla el dominio y la capa de servicios de las particularidades del motor ORM/Prisma.
 */
export interface ICollectionsRepository {
  findById(id: string): Promise<CollectionRequest | null>;
  findByIdWithDetails(id: string): Promise<any | null>;
  findOpenBatch(collectorId: string, centerId: string): Promise<any | null>;
  createOpenBatch(collectorId: string, centerId: string): Promise<any>;
  create(data: any): Promise<CollectionRequest>;
  update(id: string, data: any): Promise<CollectionRequest>;
  atomicCompleteRequest(
    id: string,
    targetBatchId: string | null,
    actualWeights: any,
    householdReward: number,
    txHash: string | null,
  ): Promise<boolean>;
  findAll(user: { id: string; role: Role }, query: FindCollectionsQueryDto): Promise<PaginatedResultDto<any>>;
  findAvailable(collectorId: string, query: AvailableCollectionsQueryDto): Promise<PaginatedResultDto<any>>;
  findOne(id: string, userId: string, role: string): Promise<any>;
}
