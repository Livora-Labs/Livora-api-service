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
  UseInterceptors,
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
import { DisputeBatchDto } from './dto/dispute-batch.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IpfsTransform } from '../common/decorators/ipfs-transform.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { RequireIdempotency } from '../common/decorators/require-idempotency.decorator';

@ApiTags('Batches')
@ApiBearerAuth()
@IpfsTransform()
@Controller('batches')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  /**
   * GET /batches (Rol: RECOLECTOR / CENTRO_ACOPIO)
   * Devuelve el historial de lotes paginado con forzado de seguridad por rol.
   */
  @Get()
  @Roles(Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Listar historial de lotes paginado (Rol: RECOLECTOR / CENTRO_ACOPIO / ALMACEN / ADMIN)',
  })
  async findAll(@CurrentUser() user: any, @Query() query: FindBatchesQueryDto) {
    return this.batchesService.findAll(user.id, user.role, query);
  }

  /**
   * GET /batches/open (Rol: RECOLECTOR)
   * Obtiene todos los lotes en estado OPEN del recolector autenticado en su vehículo,
   * con soporte de filtro opcional ?centerId para consultar el sub-lote de un acopio específico.
   */
  @Get('open')
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Listar lotes abiertos (OPEN) segmentados por Centro de Acopio en el vehículo del recolector',
  })
  async getOpenBatch(
    @CurrentUser('id') collectorId: string,
    @Query('centerId') centerId?: string,
  ) {
    return this.batchesService.getOpenBatch(collectorId, centerId);
  }

  /**
   * GET /batches/:id
   * Obtiene el detalle completo de un lote por su ID.
   */
  @Get(':id')
  @Roles(Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Consultar detalle de un lote por ID',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.batchesService.findOne(id, user);
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
   * Endpoint crítico de pesaje industrial y patrón HTTP 202 con Idempotencia en Redis.
   */
  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
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

  /**
   * POST /batches/:id/approve-flagged (Rol: ADMIN, CENTRO_ACOPIO)
   * Aprobación manual de un lote retenido en FLAGGED_FOR_REVIEW por discrepancia en pesaje.
   */
  @Post(':id/approve-flagged')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.CENTRO_ACOPIO)
  @ApiOperation({
    summary:
      'Aprobar manualmente un lote retenido en FLAGGED_FOR_REVIEW y encolar a Blockchain (Rol: ADMIN / CENTRO_ACOPIO)',
  })
  @ApiResponse({
    status: 200,
    description: 'Lote aprobado y encolado exitosamente para emisión de EcoTokens',
  })
  async approveFlaggedBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminId: string,
  ) {
    return this.batchesService.approveFlaggedBatch(id, adminId);
  }

  /**
   * POST /batches/:id/override-discrepancy (Rol: ADMIN, CENTRO_ACOPIO)
   * Autorizar y procesar un lote observado por discrepancia con nota técnica.
   */
  @Post(':id/override-discrepancy')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.CENTRO_ACOPIO)
  @ApiOperation({
    summary:
      'Autorizar y procesar lote con justificación técnica de discrepancia (Rol: ADMIN / CENTRO_ACOPIO)',
  })
  @ApiResponse({
    status: 200,
    description: 'Lote autorizado y enviado a procesamiento blockchain',
  })
  async overrideDiscrepancy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Body('discrepancyNote') discrepancyNote?: string,
  ) {
    return this.batchesService.approveFlaggedBatch(id, userId, discrepancyNote);
  }

  /**
   * POST /batches/:id/fiat-settlement (Rol: CENTRO_ACOPIO, ALMACEN)
   * Asienta contablemente el pago en efectivo (Soles) por el material físico.
   */
  @Post(':id/fiat-settlement')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Registrar cierre de pago fiduciario en efectivo (fiat) al recolector por material recibido (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  async fiatSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') centerId: string,
  ) {
    return this.batchesService.fiatSettlement(centerId, id);
  }

  /**
   * POST /batches/:id/dispute (Rol: RECOLECTOR)
   * Impugna un pesaje observado con discrepancia y congela el lote como DISPUTED.
   * Aislado estrictamente de Indecopi (Ley 29571).
   */
  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Impugnar pesaje de lote observado por discrepancia (FLAGGED_FOR_REVIEW -> DISPUTED) (Rol: RECOLECTOR)',
  })
  async disputeBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') collectorId: string,
    @Body() dto: DisputeBatchDto,
  ) {
    return this.batchesService.disputeBatch(collectorId, id, dto);
  }

  /**
   * POST /batches/:id/resolve-dispute (Rol: ADMIN)
   * Resolución arbitral de un lote en disputa.
   */
  @Post(':id/resolve-dispute')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Resolver arbitraje administrativo de un lote en disputa (DISPUTED -> RECEIVED) (Rol: ADMIN)',
  })
  async resolveDispute(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') adminId: string,
    @Body('materialsActual') materialsActual?: Record<string, any>,
    @Body('resolutionNote') resolutionNote?: string,
  ) {
    return this.batchesService.resolveDispute(
      adminId,
      id,
      materialsActual,
      resolutionNote,
    );
  }
}
