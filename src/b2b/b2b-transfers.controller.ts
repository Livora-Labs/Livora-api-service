import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { B2bTransferStatus, Role } from '@prisma/client';
import { B2bTransfersService } from './b2b-transfers.service';
import { CreateB2bTransferDto } from './dto/create-b2b-transfer.dto';
import {
  CreateB2bPurchaseRequestDto,
  AcceptB2bTransferDto,
} from './dto/b2b-request.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { RequireIdempotency } from '../common/decorators/require-idempotency.decorator';

@ApiTags('B2B Transfers')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Controller('b2b-transfers')
export class B2bTransfersController {
  constructor(private readonly b2bTransfersService: B2bTransfersService) {}

  @Get('pools')
  @Roles(Role.EMPRESA_B2B, Role.CENTRO_ACOPIO, Role.ADMIN)
  @ApiOperation({
    summary: 'Catálogo de Centros de Acopio con stock y tarifarios vigentes (B2B, Acopio, Admin)',
  })
  async getCenterPools() {
    return this.b2bTransfersService.getCenterPools();
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
  @Post('request')
  @Roles(Role.EMPRESA_B2B)
  @ApiOperation({
    summary: 'Emitir solicitud de compra a Centro de Acopio (Rol: EMPRESA_B2B)',
  })
  async createPurchaseRequest(
    @CurrentUser('id') buyerId: string,
    @Body() dto: CreateB2bPurchaseRequestDto,
  ) {
    return this.b2bTransfersService.createPurchaseRequest(buyerId, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
  @Patch(':id/accept')
  @Roles(Role.CENTRO_ACOPIO)
  @ApiOperation({
    summary: 'Aceptar pedido, ingresar kg reales y despachar lote (Rol: CENTRO_ACOPIO)',
  })
  async acceptTransfer(
    @Param('id') id: string,
    @CurrentUser('id') centerId: string,
    @Body() dto: AcceptB2bTransferDto,
  ) {
    return this.b2bTransfersService.acceptTransfer(id, centerId, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Patch(':id/receive')
  @Roles(Role.EMPRESA_B2B)
  @ApiOperation({
    summary: 'Confirmar recepción directa en planta y emitir certificado ESG (Rol: EMPRESA_B2B)',
  })
  async receiveTransfer(
    @Param('id') id: string,
    @CurrentUser('id') buyerId: string,
  ) {
    return this.b2bTransfersService.receiveTransfer(id, buyerId);
  }

  @Get()
  @Roles(Role.EMPRESA_B2B, Role.CENTRO_ACOPIO, Role.ADMIN)
  @ApiOperation({
    summary: 'Listado paginado de transferencias B2B según rol del usuario',
  })
  @ApiQuery({ name: 'status', enum: B2bTransferStatus, required: false })
  @ApiQuery({ name: 'page', type: Number, required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false })
  async getTransfers(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query('status') status?: B2bTransferStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.b2bTransfersService.getTransfers({
      userId,
      role,
      status,
      page,
      limit,
    });
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
  @Post()
  @Roles(Role.CENTRO_ACOPIO)
  @ApiOperation({
    summary: 'Despacho directo iniciado por el centro (Rol: CENTRO_ACOPIO)',
  })
  async createTransfer(
    @CurrentUser('id') centerId: string,
    @Body() dto: CreateB2bTransferDto,
  ) {
    return this.b2bTransfersService.createTransfer(centerId, dto);
  }

  @Get('incoming')
  @Roles(Role.EMPRESA_B2B)
  @ApiOperation({
    summary: 'Obtener transferencias en tránsito hacia la empresa (Rol: EMPRESA_B2B)',
  })
  async getIncomingTransfers(@CurrentUser('id') buyerId: string) {
    return this.b2bTransfersService.getIncomingTransfers(buyerId);
  }

  @Get('companies')
  @Roles(Role.CENTRO_ACOPIO, Role.ADMIN)
  @ApiOperation({
    summary: 'Listar empresas B2B registradas (Rol: CENTRO_ACOPIO / ADMIN)',
  })
  async getB2bCompanies() {
    return this.b2bTransfersService.getB2bCompanies();
  }
}
