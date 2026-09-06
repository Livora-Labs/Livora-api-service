import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { MetricsService } from './metrics.service';
import { PrometheusService } from './prometheus.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Metrics')
@Controller()
export class MetricsController {
  constructor(
    private readonly metricsService: MetricsService,
    private readonly prometheusService: PrometheusService,
  ) {}

  /**
   * GET /metrics - Endpoint público de scraping para Prometheus
   */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({
    summary: 'Endpoint de métricas en formato Prometheus (Público / Scraping)',
  })
  async getMetrics(): Promise<string> {
    return this.prometheusService.getMetrics();
  }

  @Get('households/me/metrics')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.HOGAR)
  @ApiOperation({
    summary: 'Obtener métricas de reciclaje del hogar autenticado (Rol: HOGAR)',
  })
  async getHouseholdMetrics(@CurrentUser('id') userId: string) {
    return this.metricsService.getHouseholdMetrics(userId);
  }

  @Get('collectors/me/reputation')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Obtener reputación y score del recolector (Rol: RECOLECTOR)',
  })
  async getCollectorReputation(@CurrentUser('id') userId: string) {
    return this.metricsService.getCollectorReputation(userId);
  }

  @Get('b2b/me/esg-metrics')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.EMPRESA_B2B)
  @ApiOperation({
    summary: 'Obtener métricas de impacto ambiental ESG (Rol: EMPRESA_B2B)',
  })
  async getB2bEsgMetrics(@CurrentUser('id') userId: string) {
    return this.metricsService.getB2bEsgMetrics(userId);
  }

  @Get('admin/metrics')
  @ApiBearerAuth()
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Obtener métricas globales de la plataforma (Rol: ADMIN)',
  })
  async getAdminMetrics() {
    return this.metricsService.getAdminMetrics();
  }
}
