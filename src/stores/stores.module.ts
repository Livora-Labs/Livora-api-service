import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { WalletsModule } from '../wallets/wallets.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoutingModule } from '../routing/routing.module';

import { StoreRedemptionsService } from './services/store-redemptions.service';
import { StoreSettlementsService } from './services/store-settlements.service';

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
    RoutingModule,
  ],
  controllers: [StoresController],
  providers: [
    StoresService,
    StoreRedemptionsService,
    StoreSettlementsService,
  ],
  exports: [
    StoresService,
    StoreRedemptionsService,
    StoreSettlementsService,
  ],
})
export class StoresModule {}
