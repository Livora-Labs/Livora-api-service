import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
import { ConfirmRedemptionDto } from './dto/confirm-redemption.dto';
import { UpdateSettlementStatusDto } from './dto/update-settlement-status.dto';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { RequireIdempotency } from '../common/decorators/require-idempotency.decorator';

@ApiTags('Stores')
@ApiBearerAuth()
@Controller('stores')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Post('profile')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({ summary: 'Crear perfil de tienda (Rol: TIENDA / ALMACEN)' })
  async createProfile(
    @CurrentUser() user: any,
    @Body() dto: CreateStoreProfileDto,
  ) {
    return this.storesService.createProfile(user.id, dto);
  }

  @Patch('profile')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({ summary: 'Actualizar perfil de tienda (Rol: TIENDA / ALMACEN)' })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStoreProfileDto,
  ) {
    return this.storesService.updateProfile(userId, dto);
  }

  @Get('profile')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary: 'Obtener perfil de tienda del usuario autenticado (Rol: TIENDA / ALMACEN)',
  })
  async getProfile(@CurrentUser('id') userId: string) {
    return this.storesService.getProfile(userId);
  }

  @Get('allied')
  @Roles(
    Role.HOGAR,
    Role.RECOLECTOR,
    Role.CENTRO_ACOPIO,
    Role.TIENDA,
    Role.ADMIN,
    Role.EMPRESA_B2B,
  )
  @ApiOperation({
    summary: 'Obtener catálogo de comercios y tiendas aliadas reales registradas en el sistema',
  })
  async getAlliedStores() {
    return this.storesService.getAlliedStores();
  }

  @Get()
  @Roles(
    Role.HOGAR,
    Role.RECOLECTOR,
    Role.CENTRO_ACOPIO,
    Role.TIENDA,
    Role.ADMIN,
    Role.EMPRESA_B2B,
  )
  @ApiOperation({
    summary: 'Listar todas las tiendas aliadas registradas',
  })
  async getAllStores() {
    return this.storesService.getAlliedStores();
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('redemptions/qr')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary: 'Generar código QR para canje de EcoTokens (Rol: TIENDA / ALMACEN)',
  })
  async generateQrRedemption(
    @CurrentUser() user: any,
    @Body() dto: CreateQrRedemptionDto,
  ) {
    return this.storesService.generateQrRedemption(user.id, dto);
  }

  @Get('redemptions/:qrCodeRef')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Consultar detalles del cobro (Rol: HOGAR / RECOLECTOR)',
  })
  async getRedemptionDetails(@Param('qrCodeRef') qrCodeRef: string) {
    return this.storesService.getRedemptionDetails(qrCodeRef);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
  @Post('redemptions/confirm/:qrCodeRef')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Confirmar pago de canje de EcoTokens (Rol: HOGAR / RECOLECTOR)',
  })
  async confirmRedemption(
    @CurrentUser('id') buyerUserId: string,
    @Param('qrCodeRef') qrCodeRef: string,
    @Body() dto: ConfirmRedemptionDto,
  ) {
    return this.storesService.confirmRedemption(buyerUserId, qrCodeRef, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @RequireIdempotency()
  @Post('redemptions/confirm')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Confirmar pago de canje de EcoTokens vía Body (Rol: HOGAR / RECOLECTOR)',
  })
  async confirmRedemptionFromBody(
    @CurrentUser('id') buyerUserId: string,
    @Body() dto: ConfirmRedemptionDto,
  ) {
    const ref = dto.qrCodeRef;
    if (!ref) {
      throw new BadRequestException('qrCodeRef es obligatorio en el cuerpo de la solicitud');
    }
    return this.storesService.confirmRedemption(buyerUserId, ref, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('redemptions/:id/refund')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Anular canje en punto de venta y devolver EcoTokens al hogar dentro de las 24 horas (Rol: TIENDA)',
  })
  async refundRedemption(
    @CurrentUser('id') storeUserId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.storesService.refundRedemption(storeUserId, id);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('settlements')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Solicitar liquidación de EcoTokens acumulados a FIAT (Rol: TIENDA / ALMACEN)',
  })
  async requestSettlement(
    @CurrentUser() user: any,
    @Body() dto: CreateSettlementRequestDto,
  ) {
    return this.storesService.requestSettlement(user.id, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Patch('settlements/:id/pay')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Aprobar y registrar pago de liquidación (Rol: ADMIN)',
  })
  async paySettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySettlementDto,
  ) {
    return this.storesService.paySettlement(id, dto);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Patch('settlements/:id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Actualizar estado de liquidación (APPROVED_PENDING_PAYMENT, PAID, REJECTED) (Rol: ADMIN)',
  })
  async updateSettlementStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSettlementStatusDto,
  ) {
    return this.storesService.updateSettlementStatus(id, dto);
  }

  @Get('redemptions')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary: 'Obtener historial de canjes de la tienda (Rol: TIENDA / ALMACEN)',
  })
  async getRedemptions(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.storesService.getRedemptions(
      userId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 15,
    );
  }

  @Get('settlements/history')
  @Roles(Role.TIENDA, Role.ALMACEN)
  @ApiOperation({
    summary: 'Obtener historial de liquidaciones de la tienda (Rol: TIENDA / ALMACEN)',
  })
  async getSettlements(
    @CurrentUser('id') userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.storesService.getSettlements(
      userId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 15,
    );
  }
}
