import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { AuditLogBufferService } from '../common/services/audit-log-buffer.service';
import { BLOCKCHAIN_QUEUE, BLOCKCHAIN_DLQ } from '../blockchain/blockchain.constants';

@Module({
  imports: [
    PrismaModule,
    BlockchainModule,
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
