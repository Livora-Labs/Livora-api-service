import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BatchesController } from './batches.controller';
import { ConsolidatedBatchesController } from './consolidated-batches.controller';
import { BatchesService } from './batches.service';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BatchesRepository } from './repositories/batches.repository';

// Servicios de dominio especializados (PUCP Disoft - Single Responsibility Principle & GoF Facade)
import { BatchReceptionService } from './services/batch-reception.service';
import { BatchDisputeService } from './services/batch-dispute.service';
import { BatchSettlementService } from './services/batch-settlement.service';
import { BatchConsolidationService } from './services/batch-consolidation.service';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    NotificationsModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: 'blockchain-queue',
    }),
  ],
  controllers: [BatchesController, ConsolidatedBatchesController],
  providers: [
    BatchesService,
    BatchesRepository,
    BatchReceptionService,
    BatchDisputeService,
    BatchSettlementService,
    BatchConsolidationService,
  ],
  exports: [
    BatchesService,
    BatchesRepository,
    BatchReceptionService,
    BatchDisputeService,
    BatchSettlementService,
    BatchConsolidationService,
  ],
})
export class BatchesModule {}
