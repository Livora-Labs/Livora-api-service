import { Module } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CollectionAuctionService } from './services/collection-auction.service';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BlockchainModule,
    WebsocketsModule,
    NotificationsModule,
  ],
  controllers: [CollectionsController],
  providers: [CollectionsService, CollectionAuctionService],
  exports: [CollectionsService, CollectionAuctionService],
})
export class CollectionsModule {}
