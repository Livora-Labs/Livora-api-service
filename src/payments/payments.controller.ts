import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { ProcessPaymentWebhookDto } from './dto/process-payment-webhook.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('niubiz/session')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Generar token de sesión para pasarela Niubiz (1 PEN = 1 ECO) exclusivo para HOGAR y RECOLECTOR',
  })
  @ApiResponse({
    status: 201,
    description: 'Sesión generada exitosamente',
  })
  async createSession(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentSessionDto,
    @Req() req: FastifyRequest,
  ) {
    const rawIp =
      (req.headers['x-forwarded-for'] as string) ||
      (req.headers['x-real-ip'] as string) ||
      req.ip;
    const clientIp = rawIp ? rawIp.split(',')[0].trim() : '190.236.10.15';
    return this.paymentsService.createSession(userId, dto, clientIp);
  }

  @Post('niubiz/confirm')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Confirmación autenticada de recarga con transactionToken capturado por la app móvil',
  })
  @ApiResponse({
    status: 200,
    description: 'Transacción autorizada y tokens encolados para minteo',
  })
  async confirmPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmPaymentDto,
  ) {
    return this.paymentsService.confirmPayment(userId, dto);
  }

  @Get('niubiz/checkout-page/:purchaseNumber')
  @ApiOperation({
    summary:
      'Renderiza la vista HTML responsiva de checkout con checkout.js para el WebView móvil',
  })
  async renderCheckoutPage(
    @Param('purchaseNumber') purchaseNumber: string,
    @Res() res: FastifyReply,
  ) {
    const html = await this.paymentsService.renderCheckoutPage(purchaseNumber);
    res.type('text/html; charset=utf-8').send(html);
  }

  @HttpCode(HttpStatus.OK)
  @Post('niubiz/webhook')
  @ApiOperation({
    summary:
      'Webhook server-to-server de Niubiz protegido con firma criptográfica HMAC-SHA256',
  })
  @ApiResponse({
    status: 200,
    description: 'Pago confirmado por webhook',
  })
  async processWebhook(@Body() dto: ProcessPaymentWebhookDto) {
    return this.paymentsService.processWebhook(dto);
  }

  @Get('me/transactions')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consultar historial de recargas del usuario móvil autenticado',
  })
  async getTransactions(@CurrentUser('id') userId: string) {
    return this.paymentsService.getUserTransactions(userId);
  }
}
