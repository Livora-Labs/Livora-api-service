import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CollectionsModule } from './collections/collections.module';
import { BatchesModule } from './batches/batches.module';
import { CentersModule } from './centers/centers.module';
import { WalletsModule } from './wallets/wallets.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MetricsModule } from './metrics/metrics.module';
import { AdminModule } from './admin/admin.module';
import { SalesModule } from './sales/sales.module';
import { InventoryModule } from './inventory/inventory.module';
import { WebsocketsModule } from './websockets/websockets.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { StoresModule } from './stores/stores.module';
import { B2bTransfersModule } from './b2b/b2b-transfers.module';
import { BetaModule } from './beta/beta.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    PrismaModule,
    SupabaseModule,
    UsersModule,
    AuthModule,
    CollectionsModule,
    BatchesModule,
    CentersModule,
    WalletsModule,
    NotificationsModule,
    MetricsModule,
    AdminModule,
    SalesModule,
    InventoryModule,
    WebsocketsModule,
    BlockchainModule,
    StoresModule,
    B2bTransfersModule,
    BetaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

