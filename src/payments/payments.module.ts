import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { NiubizClient } from './services/niubiz.client';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';

@Module({
  imports: [
    PrismaModule,
    BlockchainModule,
    NotificationsModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: BLOCKCHAIN_QUEUE,
    }),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, NiubizClient],
  exports: [PaymentsService, NiubizClient],
})
export class PaymentsModule {}
