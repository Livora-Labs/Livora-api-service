import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { B2bTransfersService } from './b2b-transfers.service';
import { CreateB2bTransferDto } from './dto/create-b2b-transfer.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('B2B Transfers')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Controller('b2b-transfers')
export class B2bTransfersController {
  constructor(private readonly b2bTransfersService: B2bTransfersService) {}

  @Post()
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Registrar envío de material a empresa B2B (Rol: CENTRO_ACOPIO / ALMACEN)',
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
    summary:
      'Obtener transferencias en tránsito destinadas a la empresa (Rol: EMPRESA_B2B)',
  })
  async getIncomingTransfers(@CurrentUser('id') buyerId: string) {
    return this.b2bTransfersService.getIncomingTransfers(buyerId);
  }

  @Patch(':id/receive')
  @Roles(Role.EMPRESA_B2B)
  @ApiOperation({
    summary: 'Confirmar recepción y emitir certificado ESG (Rol: EMPRESA_B2B)',
  })
  async receiveTransfer(
    @Param('id') id: string,
    @CurrentUser('id') buyerId: string,
  ) {
    return this.b2bTransfersService.receiveTransfer(id, buyerId);
  }

  @Get('companies')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Listar todas las empresas B2B registradas (Rol: CENTRO_ACOPIO / ALMACEN / ADMIN)',
  })
  async getB2bCompanies() {
    return this.b2bTransfersService.getB2bCompanies();
  }
}
