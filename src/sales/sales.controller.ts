import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateCertificateDto } from '../certificates/dto/create-certificate.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Sales & Certificates')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Controller()
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('sales')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Registrar venta de material consolidado a empresa B2B (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  async createSale(
    @CurrentUser('id') centerId: string,
    @Body() dto: CreateSaleDto,
  ) {
    return this.salesService.createSale(centerId, dto);
  }

  @Get('certificates')
  @Roles(Role.EMPRESA_B2B, Role.ADMIN)
  @ApiOperation({
    summary:
      'Listar certificados ESG emitidos para la empresa B2B o todos para ADMIN (Rol: EMPRESA_B2B / ADMIN)',
  })
  async getCertificates(
    @CurrentUser() user: any,
    @Query() query: PaginationQueryDto,
  ) {
    return this.salesService.getCertificates(user.id, user.role, query);
  }

  @Get('certificates/:id')
  @Roles(Role.EMPRESA_B2B, Role.ADMIN)
  @ApiOperation({
    summary: 'Obtener detalle de certificado ESG por ID (Rol: EMPRESA_B2B / ADMIN)',
  })
  async getCertificateById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.salesService.getCertificateById(id, user.id, user.role);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('certificates')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Emitir / Mintear certificado ESG simulado con IPFS hash (Rol: ADMIN)',
  })
  async createCertificate(@Body() dto: CreateCertificateDto) {
    return this.salesService.createCertificate(dto);
  }

  @Get('sales')
  @Roles(Role.EMPRESA_B2B, Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Obtener historial de compras/ventas (Rol: B2B o Acopio / Almacén)',
  })
  async getSales(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.salesService.getSalesForUser(userId, role);
  }
}
