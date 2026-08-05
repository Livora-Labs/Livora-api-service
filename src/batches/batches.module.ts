import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BatchesController } from './batches.controller';
import { ConsolidatedBatchesController } from './consolidated-batches.controller';
import { BatchesService } from './batches.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'blockchain-queue',
    }),
  ],
  controllers: [BatchesController, ConsolidatedBatchesController],
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
