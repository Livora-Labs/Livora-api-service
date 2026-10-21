import { Module, forwardRef } from '@nestjs/common';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { WalletsRepository } from './repositories/wallets.repository';
import { WalletHistoryAggregatorService } from './services/wallet-history.aggregator';

@Module({
  imports: [PrismaModule, forwardRef(() => BlockchainModule)],
  controllers: [WalletsController],
  providers: [
    WalletsService,
    WalletsRepository,
    WalletHistoryAggregatorService,
  ],
  exports: [
    WalletsService,
    WalletsRepository,
    WalletHistoryAggregatorService,
  ],
})
export class WalletsModule {}
