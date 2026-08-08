import { Module } from '@nestjs/common';
import { B2bTransfersController } from './b2b-transfers.controller';
import { B2bTransfersService } from './b2b-transfers.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';

@Module({
  imports: [PrismaModule, BlockchainModule],
  controllers: [B2bTransfersController],
  providers: [B2bTransfersService],
  exports: [B2bTransfersService],
})
export class B2bTransfersModule {}
