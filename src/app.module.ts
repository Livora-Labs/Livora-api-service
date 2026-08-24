import { ExecutionContext, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from 'nestjs-throttler-storage-redis';
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
import { ComplaintsModule } from './complaints/complaints.module';
import { UploadsModule } from './uploads/uploads.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MailService } from './common/services/mail.service';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    RedisModule,
    HealthModule,
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
    ComplaintsModule,
    UploadsModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60000,
            limit: 100,
          },
          {
            name: 'auth_strict',
            ttl: 60000,
            limit: 5,
            skipIf: (context: ExecutionContext) => {
              const handler = context.getHandler();
              const classRef = context.getClass();
              const hasLimit =
                Reflect.getMetadata('THROTTLER:LIMITauth_strict', handler) !==
                  undefined ||
                Reflect.getMetadata('THROTTLER:LIMITauth_strict', classRef) !==
                  undefined;
              return !hasLimit;
            },
          },
          {
            name: 'web3_transactions',
            ttl: 60000,
            limit: 10,
            skipIf: (context: ExecutionContext) => {
              const handler = context.getHandler();
              const classRef = context.getClass();
              const hasLimit =
                Reflect.getMetadata(
                  'THROTTLER:LIMITweb3_transactions',
                  handler,
                ) !== undefined ||
                Reflect.getMetadata(
                  'THROTTLER:LIMITweb3_transactions',
                  classRef,
                ) !== undefined;
              return !hasLimit;
            },
          },
          {
            // Anti-spam para el Libro de Reclamaciones: máx 3 reclamos por hora por IP
            name: 'complaints',
            ttl: 3600000,
            limit: 3,
            skipIf: (context: ExecutionContext) => {
              const handler = context.getHandler();
              const classRef = context.getClass();
              const hasLimit =
                Reflect.getMetadata('THROTTLER:LIMITcomplaints', handler) !==
                  undefined ||
                Reflect.getMetadata('THROTTLER:LIMITcomplaints', classRef) !==
                  undefined;
              return !hasLimit;
            },
          },
        ],
        storage: new ThrottlerStorageRedisService({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
        }),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
