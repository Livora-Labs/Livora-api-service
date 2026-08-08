import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { WalletsModule } from '../wallets/wallets.module';
import { WebsocketsModule } from '../websockets/websockets.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'blockchain-queue',
    }),
    WalletsModule,
    WebsocketsModule,
  ],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
