import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { IpfsService } from './blockchain/services/ipfs.service';
import { BlockchainService } from './blockchain/services/blockchain.service';
import { StellarSequenceManager } from './blockchain/services/stellar-sequence-manager.service';
import { StellarRpcManagerService } from './blockchain/services/stellar-rpc-manager.service';
import { BlockchainProcessor } from './blockchain/blockchain.processor';
import { SorobanTtlBumpWorker } from './blockchain/workers/soroban-ttl-bump.worker';
import { RedemptionExpirationWorker } from './stores/workers/redemption-expiration.worker';
import {
  BLOCKCHAIN_QUEUE,
  BLOCKCHAIN_DLQ,
} from './blockchain/blockchain.constants';
import { NotificationsService } from './notifications/notifications.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    PrismaModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 1000 },
        },
      }),
    }),
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
    BlockchainProcessor,
    SorobanTtlBumpWorker,
    RedemptionExpirationWorker,
    IpfsService,
    BlockchainService,
    StellarSequenceManager,
    StellarRpcManagerService,
    NotificationsService,
  ],
})
export class WorkerAppModule {}
