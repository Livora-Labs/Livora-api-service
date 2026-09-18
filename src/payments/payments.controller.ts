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
import { IzipayIpnDto } from './dto/izipay-ipn.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(['izipay/session', 'crear-token', '/api/pagos/crear-token'])
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.RECOLECTOR, Role.TIENDA)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Generar formToken para pasarela Izipay V4 (1 PEN = 1 ECO) exclusivo para RECOLECTOR y TIENDA',
  })
  @ApiResponse({
    status: 201,
    description: 'Sesión Izipay generada y formToken emitido exitosamente',
  })
  async createSession(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentSessionDto,
  ) {
    return this.paymentsService.createSession(userId, dto);
  }

  @Get(['izipay/checkout-page/:orderId', 'checkout-page/:orderId'])
  @ApiOperation({
    summary:
      'Renderiza la vista HTML responsiva de checkout con Krypton V4 de Izipay para el WebView móvil',
  })
  async renderCheckoutPage(
    @Param('orderId') orderId: string,
    @Res() res: FastifyReply,
  ) {
    const html = await this.paymentsService.renderCheckoutPage(orderId);
    res
      .header(
        'Content-Security-Policy',
        "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.micuentaweb.pe; " +
          "style-src 'self' 'unsafe-inline' https://static.micuentaweb.pe; " +
          "connect-src 'self' https://api.micuentaweb.pe https://static.micuentaweb.pe https:; " +
          "frame-src 'self' https://static.micuentaweb.pe https://api.micuentaweb.pe; " +
          "img-src 'self' data: https: https://static.micuentaweb.pe;",
      )
      .type('text/html; charset=utf-8')
      .send(html);
  }

  @HttpCode(HttpStatus.OK)
  @Post(['izipay-ipn', '/api/pagos/izipay-ipn'])
  @ApiOperation({
    summary:
      'Notificación de Pago Instantánea (IPN / Webhook) de Izipay verificada con HMAC-SHA256',
  })
  @ApiResponse({
    status: 200,
    description: 'IPN validado e instrucciones de minteo on-chain encoladas',
  })
  async processIzipayIpn(
    @Body() dto: IzipayIpnDto,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    // Acepta payload parseado o deserializado desde request body
    const body = (req.body as any) || dto;
    const responseText = await this.paymentsService.processIzipayIpn(body);
    res.type('text/plain; charset=utf-8').send(responseText);
  }

  @Get('me/transactions')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles(Role.RECOLECTOR, Role.TIENDA)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Consultar historial de recargas del usuario móvil autenticado',
  })
  async getTransactions(@CurrentUser('id') userId: string) {
    return this.paymentsService.getUserTransactions(userId);
  }
}
