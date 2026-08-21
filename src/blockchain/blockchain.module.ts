import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IpfsService } from './services/ipfs.service';
import { BlockchainService } from './services/blockchain.service';
import { BlockchainProcessor } from './blockchain.processor';
import { BLOCKCHAIN_QUEUE } from './blockchain.constants';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WebsocketsModule,
    NotificationsModule,
    BullModule.registerQueue({
      name: BLOCKCHAIN_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    }),
  ],
  providers: [BlockchainProcessor, IpfsService, BlockchainService],
  exports: [IpfsService, BlockchainService],
})
export class BlockchainModule {}
