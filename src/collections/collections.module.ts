import { Module } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { NotificationsModule } from '../notifications/notifications.module';

// Servicios modulares y patrones de diseño (PUCP Disoft)
import { CollectionAuctionService } from './services/collection-auction.service';
import { CollectionLifecycleService } from './services/collection-lifecycle.service';
import { CollectionVerificationService } from './services/collection-verification.service';
import { CollectionTrackingService } from './services/collection-tracking.service';
import { CollectionEscrowService } from './services/collection-escrow.service';
import { CollectionsRepository } from './repositories/collections.repository';
import { RewardCalculatorFactory } from './factories/reward-calculator.factory';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BlockchainModule,
    WebsocketsModule,
    NotificationsModule,
  ],
  controllers: [CollectionsController],
  providers: [
    CollectionsService,
    CollectionAuctionService,
    CollectionLifecycleService,
    CollectionVerificationService,
    CollectionTrackingService,
    CollectionEscrowService,
    CollectionsRepository,
    RewardCalculatorFactory,
  ],
  exports: [
    CollectionsService,
    CollectionAuctionService,
    CollectionLifecycleService,
    CollectionVerificationService,
    CollectionTrackingService,
    CollectionEscrowService,
    CollectionsRepository,
    RewardCalculatorFactory,
  ],
})
export class CollectionsModule {}
