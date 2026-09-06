import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { WalletsModule } from '../wallets/wallets.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    RedisModule,
    BullModule.registerQueue({
      name: 'blockchain-queue',
    }),
    WalletsModule,
    WebsocketsModule,
    BlockchainModule,
    NotificationsModule,
  ],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
