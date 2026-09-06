import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: BLOCKCHAIN_QUEUE,
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
