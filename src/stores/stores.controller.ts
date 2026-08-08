import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StoresService } from './stores.service';
import { CreateStoreProfileDto } from './dto/create-store-profile.dto';
import { CreateQrRedemptionDto } from './dto/create-qr-redemption.dto';
import { CreateSettlementRequestDto } from './dto/create-settlement-request.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Post('profile')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Crear perfil de tienda (Rol: TIENDA)' })
  async createProfile(
    @CurrentUser() user: any,
    @Body() dto: CreateStoreProfileDto,
  ) {
    return this.storesService.createProfile(user.id, dto);
  }

  @Get('profile')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Obtener perfil de tienda del usuario autenticado (Rol: TIENDA)' })
  async getProfile(@CurrentUser('id') userId: string) {
    return this.storesService.getProfile(userId);
  }

  @Post('redemptions/qr')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Generar código QR para canje de EcoTokens (Rol: TIENDA)' })
  async generateQrRedemption(
    @CurrentUser() user: any,
    @Body() dto: CreateQrRedemptionDto,
  ) {
    return this.storesService.generateQrRedemption(user.id, dto);
  }

  @Get('redemptions/:qrCodeRef')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({ summary: 'Consultar detalles del cobro (Rol: HOGAR / RECOLECTOR)' })
  async getRedemptionDetails(@Param('qrCodeRef') qrCodeRef: string) {
    return this.storesService.getRedemptionDetails(qrCodeRef);
  }

  @Post('redemptions/confirm/:qrCodeRef')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({ summary: 'Confirmar pago de canje de EcoTokens (Rol: HOGAR / RECOLECTOR)' })
  async confirmRedemption(
    @CurrentUser('id') buyerUserId: string,
    @Param('qrCodeRef') qrCodeRef: string,
  ) {
    return this.storesService.confirmRedemption(buyerUserId, qrCodeRef);
  }

  @Post('settlements')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Solicitar liquidación de EcoTokens acumulados a FIAT (Rol: TIENDA)' })
  async requestSettlement(
    @CurrentUser() user: any,
    @Body() dto: CreateSettlementRequestDto,
  ) {
    return this.storesService.requestSettlement(user.id, dto);
  }

  @Patch('settlements/:id/pay')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Aprobar y registrar pago de liquidación (Rol: ADMIN)' })
  async paySettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySettlementDto,
  ) {
    return this.storesService.paySettlement(id, dto);
  }

  @Get('redemptions')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Obtener historial de canjes de la tienda (Rol: TIENDA)' })
  async getRedemptions(@CurrentUser('id') userId: string) {
    return this.storesService.getRedemptions(userId);
  }

  @Get('settlements/history')
  @Roles(Role.TIENDA)
  @ApiOperation({ summary: 'Obtener historial de liquidaciones de la tienda (Rol: TIENDA)' })
  async getSettlements(@CurrentUser('id') userId: string) {
    return this.storesService.getSettlements(userId);
  }
}
