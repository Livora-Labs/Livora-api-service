import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MetricsModule } from '../metrics/metrics.module';
import { IpfsService } from './services/ipfs.service';
import { BlockchainService } from './services/blockchain.service';
import { StellarSequenceManager } from './services/stellar-sequence-manager.service';
import { StellarRpcManagerService } from './services/stellar-rpc-manager.service';
import { BLOCKCHAIN_QUEUE, BLOCKCHAIN_DLQ } from './blockchain.constants';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    WebsocketsModule,
    NotificationsModule,
    forwardRef(() => MetricsModule),
    BullModule.registerQueue(
      {
        name: BLOCKCHAIN_QUEUE,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 1000 },
        },
      },
      {
        name: BLOCKCHAIN_DLQ,
        defaultJobOptions: {
          removeOnComplete: { count: 500 },
          removeOnFail: false,
        },
      },
    ),
  ],
  providers: [
    IpfsService,
    BlockchainService,
    StellarSequenceManager,
    StellarRpcManagerService,
  ],
  exports: [
    IpfsService,
    BlockchainService,
    StellarSequenceManager,
    StellarRpcManagerService,
  ],
})
export class BlockchainModule {}
