import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { BatchesService } from './batches.service';
import { CreateConsolidatedBatchDto } from './dto/create-consolidated-batch.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Consolidations')
@ApiBearerAuth()
@Controller('consolidated-batches')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ConsolidatedBatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  @Post()
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({ summary: 'Consolidar múltiples lotes recibidos (Rol: CENTRO_ACOPIO / ALMACEN)' })
  @ApiResponse({ status: 201, description: 'Lote consolidado creado exitosamente con estado PENDING_SALE' })
  async createConsolidatedBatch(
    @CurrentUser('id') centerId: string,
    @Body() dto: CreateConsolidatedBatchDto,
  ) {
    return this.batchesService.createConsolidatedBatch(centerId, dto);
  }
}
