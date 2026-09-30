import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { AuthModule } from '../auth/auth.module';
import { AuditLogBufferService } from '../common/services/audit-log-buffer.service';
import { BLOCKCHAIN_QUEUE, BLOCKCHAIN_DLQ } from '../blockchain/blockchain.constants';

import { NotificationsModule } from '../notifications/notifications.module';
import { WebsocketsModule } from '../websockets/websockets.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BlockchainModule,
    AuthModule,
    NotificationsModule,
    WebsocketsModule,
    BullModule.registerQueue(
      {
        name: BLOCKCHAIN_QUEUE,
      },
      {
        name: BLOCKCHAIN_DLQ,
      },
    ),
  ],
  controllers: [AdminController],
  providers: [AdminService, AuditLogBufferService],
  exports: [AdminService],
})
export class AdminModule {}
