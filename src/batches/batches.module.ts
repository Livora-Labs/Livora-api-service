import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BatchesController } from './batches.controller';
import { ConsolidatedBatchesController } from './consolidated-batches.controller';
import { BatchesService } from './batches.service';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebsocketsModule } from '../websockets/websockets.module';

@Module({
  imports: [
    RedisModule,
    NotificationsModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: 'blockchain-queue',
    }),
  ],
  controllers: [BatchesController, ConsolidatedBatchesController],
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
