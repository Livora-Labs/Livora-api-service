import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { BatchesService } from './batches.service';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { ReceiveBatchDto } from './dto/receive-batch.dto';
import { FindBatchesQueryDto } from './dto/find-batches-query.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Batches')
@ApiBearerAuth()
@Controller('batches')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  /**
   * GET /batches (Rol: RECOLECTOR / CENTRO_ACOPIO)
   * Devuelve el historial de lotes paginado con forzado de seguridad por rol.
   */
  @Get()
  @Roles(Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Listar historial de lotes paginado (Rol: RECOLECTOR / CENTRO_ACOPIO / ALMACEN)',
  })
  async findAll(@CurrentUser() user: any, @Query() query: FindBatchesQueryDto) {
    return this.batchesService.findAll(user.id, user.role, query);
  }

  /**
   * GET /batches/open (Rol: RECOLECTOR)
   * Busca o crea un lote en estado OPEN asociado al recolector autenticado.
   */
  @Get('open')
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Obtener o crear lote abierto (OPEN) para el recolector',
  })
  async getOpenBatch(@CurrentUser('id') collectorId: string) {
    return this.batchesService.getOpenBatch(collectorId);
  }

  /**
   * PATCH /batches/:id (Rol: RECOLECTOR)
   * Asigna un centro de acopio destino (destinationCenterId) al lote actual y cambia estado a IN_TRANSIT.
   */
  @Patch(':id')
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Asignar Centro de Acopio destino al lote y ponerlo en tránsito (IN_TRANSIT)',
  })
  async updateBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') collectorId: string,
    @Body() dto: UpdateBatchDto,
  ) {
    return this.batchesService.updateBatch(id, collectorId, dto);
  }

  /**
   * POST /batches/:id/receive (Rol: CENTRO_ACOPIO / ALMACEN)
   * Endpoint crítico de pesaje industrial y patrón HTTP 202.
   */
  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post(':id/receive')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Recepción del lote en Centro de Acopio / Almacén (Dispara procesador Blockchain / BullMQ - HTTP 202)',
  })
  @ApiResponse({
    status: 202,
    description: 'Recepción aceptada y trabajo encolado en BullMQ',
  })
  async receiveBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') centerId: string,
    @Body() dto: ReceiveBatchDto,
  ) {
    return this.batchesService.receiveBatch(id, centerId, dto);
  }
}
