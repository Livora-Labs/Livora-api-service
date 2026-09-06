import { Module, forwardRef } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { PrometheusService } from './prometheus.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [PrismaModule, forwardRef(() => WalletsModule)],
  controllers: [MetricsController],
  providers: [MetricsService, PrometheusService],
  exports: [MetricsService, PrometheusService],
})
export class MetricsModule {}
