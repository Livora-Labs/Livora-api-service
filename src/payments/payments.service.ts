import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { IzipayClient } from './services/izipay.client';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { IzipayIpnDto } from './dto/izipay-ipn.dto';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';

import { MailService } from '../common/services/mail.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly izipayClient: IzipayClient,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly notificationsService: NotificationsService,
    private readonly websocketsService: WebsocketsService,
    @Optional() private readonly mailService?: MailService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
  ) {}

  /**
   * Genera una sesión de recarga Izipay (Krypton V4) para RECOLECTOR y TIENDA
   */
  async createSession(
    userId: string,
    dto: CreatePaymentSessionDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // Regla de negocio: Exclusividad para RECOLECTOR y TIENDA
    if (user.role !== Role.RECOLECTOR && user.role !== Role.TIENDA) {
      throw new ForbiddenException(
        'El rol actual no opera con recargas fiduciarias de LIVOs vía pasarela Izipay',
      );
    }

    const effectiveAmount = dto.getEffectiveAmount();
    if (effectiveAmount < 10.0) {
      throw new BadRequestException('El monto mínimo de recarga es de S/ 10.00 Soles');
    }
    if (effectiveAmount > 500.0) {
      throw new BadRequestException('El monto máximo de recarga por operación es de S/ 500.00 Soles');
    }

    // Regla de control financiero: Límite diario acumulado de S/ 500.00 PEN en las últimas 24 horas
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyAgg = await this.prisma.paymentTransaction.aggregate({
      where: {
        userId,
        status: 'COMPLETED',
        createdAt: { gte: since24h },
      },
      _sum: {
        amountPen: true,
      },
    });

    const currentDailyTotal = Number(dailyAgg._sum.amountPen || 0);
    if (currentDailyTotal + effectiveAmount > 500.0) {
      throw new BadRequestException(
        `Límite diario de recarga excedido. Tu acumulado en las últimas 24 horas es S/ ${currentDailyTotal.toFixed(2)} PEN. El monto máximo permitido es S/ 500.00 PEN por día.`,
      );
    }

    // Identificador único de orden para Izipay (alfanumérico)
    const orderId = `ECO-${Date.now()}-${user.id.slice(0, 4).toUpperCase()}`;

    // Registrar transacción en estado PENDING
    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        userId,
        amountPen: effectiveAmount,
        tokenAmount: effectiveAmount, // 1 PEN = 1 EcoToken
        purchaseNumber: orderId,
        status: 'PENDING',
        blockchainStatus: 'PENDING',
      },
    });

    const email = dto.customerEmail || user.email;
    const wallet = dto.userWalletAddress || user.walletAddress || undefined;

    const izipayRes = await this.izipayClient.createPaymentToken({
      amountInSoles: effectiveAmount,
      orderId,
      customerEmail: email,
      userWalletAddress: wallet,
      userId: user.id,
    });

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        transactionToken: izipayRes.formToken,
      },
    });

    return {
      success: true,
      transactionId: transaction.id,
      orderId,
      purchaseNumber: orderId,
      amount: effectiveAmount,
      tokenAmount: effectiveAmount,
      formToken: izipayRes.formToken,
    };
  }

  /**
   * Procesa la notificación instantánea de pago (IPN / Webhook) enviada por Izipay
   */
  async processIzipayIpn(dto: IzipayIpnDto | Record<string, any>): Promise<string> {
    const krAnswerRaw = dto['kr-answer'];
    const krHash = dto['kr-hash'];

    if (!krAnswerRaw || !krHash) {
      this.logger.error('[Izipay IPN] Payload inválido: faltan kr-answer o kr-hash');
      throw new BadRequestException('Faltan parámetros requeridos de firma Izipay (kr-answer, kr-hash)');
    }

    // 1. Verificación Criptográfica HMAC-SHA256
    const hashKeyType = dto['kr-hash-key'];
    const isSignatureValid = this.izipayClient.verifyHmac(krAnswerRaw, krHash, hashKeyType);
    if (!isSignatureValid) {
      this.logger.error('[Izipay IPN] Fallo de autenticación: Firma HMAC-SHA256 no coincide');
      throw new BadRequestException('Firma HMAC-SHA256 inválida');
    }

    const krAnswer =
      typeof krAnswerRaw === 'string' ? JSON.parse(krAnswerRaw) : krAnswerRaw;

    // 2. Extraer identificadores
    const orderId =
      krAnswer.orderDetails?.orderId ||
      krAnswer.orderId ||
      krAnswer.transactions?.[0]?.transactionDetails?.parentTransactionUuid;

    if (!orderId) {
      this.logger.error('[Izipay IPN] kr-answer no incluye orderDetails.orderId');
      throw new BadRequestException('No se pudo identificar el orderId de la transacción');
    }

    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: orderId },
      include: { user: true },
    });

    if (!transaction) {
      this.logger.warn(`[Izipay IPN] Transacción con orderId ${orderId} no encontrada en BD`);
      throw new NotFoundException(`Transacción ${orderId} no encontrada`);
    }

    // 3. Idempotencia: Si ya fue completada, responder OK
    if (transaction.status === 'COMPLETED') {
      this.logger.log(`[Izipay IPN] Transacción ${orderId} ya procesada previamente (Idempotencia)`);
      return 'OK';
    }

    // 4. Validar estado reportado por Izipay
    const orderStatus = krAnswer.orderStatus;
    const isPaid = orderStatus === 'PAID';

    const firstTx = krAnswer.transactions?.[0];
    const cardDetails = firstTx?.transactionDetails?.cardDetails;
    const cardBrand = cardDetails?.effectiveBrand || cardDetails?.paymentMethodType || 'CARD';
    const cardPanMasked = cardDetails?.pan || null;
    const authorizationCode =
      cardDetails?.authorizationResponse?.authorizationNumber ||
      firstTx?.uuid ||
      null;

    if (!isPaid) {
      this.logger.warn(
        `[Izipay IPN] Orden ${orderId} recibida con estado no pagado: ${orderStatus}`,
      );
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          gatewayResponse: krAnswer,
        },
      });
      return 'OK';
    }

    // 5. Marcar como COMPLETED en BD
    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        cardBrand,
        cardPanMasked,
        authorizationCode,
        gatewayResponse: krAnswer,
      },
    });

    // 6. Ejecutar o encolar Minteo on-chain en Stellar/Soroban
    const targetUser = transaction.user;
    if (targetUser.walletAddress) {
      try {
        if (this.blockchainQueue) {
          await this.blockchainQueue.add(
            'izipay-mint-tokens',
            {
              userId: targetUser.id,
              walletAddress: targetUser.walletAddress,
              amount: Number(transaction.tokenAmount),
              purchaseNumber: transaction.purchaseNumber,
            },
            {
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
            },
          );
          this.logger.log(
            `[Izipay IPN] Minteo on-chain encolado en BullMQ para ${targetUser.walletAddress} (${transaction.tokenAmount} ECO)`,
          );
        } else {
          // Si no hay BullMQ en el entorno de ejecución, minteo directo
          const receipt = await this.blockchainService.mintEcoTokens(
            targetUser.walletAddress,
            Number(transaction.tokenAmount),
          );
          if (receipt?.hash) {
            await this.prisma.paymentTransaction.update({
              where: { id: transaction.id },
              data: { txHash: receipt.hash, blockchainStatus: 'MINTED' },
            });
            this.logger.log(
              `[Izipay IPN] Minteo on-chain directo completado. Hash: ${receipt.hash}`,
            );
          }
        }
      } catch (mintErr: any) {
        this.logger.error(
          `[Izipay IPN] Error al procesar acreditación de saldo para ${orderId}: ${mintErr.message}`,
        );
        await this.prisma.paymentTransaction.update({
          where: { id: transaction.id },
          data: { blockchainStatus: 'FAILED_BLOCKCHAIN' },
        }).catch(() => {});

        // Notificar al Administrador sobre la acreditación pendiente
        if (this.mailService) {
          await this.mailService.sendAccreditationAlertToAdmin({
            adminEmail: 'danielarmando023@gmail.com',
            purchaseNumber: transaction.purchaseNumber,
            userEmail: targetUser.email,
            userName: targetUser.name || 'Usuario Livora',
            amountPen: Number(transaction.amountPen),
            tokenAmount: Number(transaction.tokenAmount),
            cardBrand,
            errorMessage: mintErr.message,
          }).catch(() => {});
        }
      }
    } else {
      this.logger.warn(
        `[Izipay IPN] Usuario ${targetUser.id} no posee dirección de cuenta configurada. Acreditación en espera.`,
      );
      if (this.mailService) {
        await this.mailService.sendAccreditationAlertToAdmin({
          adminEmail: 'danielarmando023@gmail.com',
          purchaseNumber: transaction.purchaseNumber,
          userEmail: targetUser.email,
          userName: targetUser.name || 'Usuario Livora',
          amountPen: Number(transaction.amountPen),
          tokenAmount: Number(transaction.tokenAmount),
          cardBrand,
          errorMessage: 'El usuario no tiene una cuenta de monedero vinculada para acreditar saldo.',
        }).catch(() => {});
      }
    }

    // 7. Notificación Push al usuario (vocabulario fintech familiar sin jerga Web3)
    this.notificationsService
      .sendPushNotification(
        targetUser.id,
        'Pago confirmado · Recarga en proceso',
        `Se ha confirmado tu pago de S/ ${Number(transaction.amountPen).toFixed(2)} PEN. Tus ${Number(transaction.tokenAmount).toFixed(2)} LIVOs se reflejarán en tu saldo disponible en unos instantes.`,
        { purchaseNumber: transaction.purchaseNumber },
      )
      .catch(() => {});

    // Notificación en tiempo real vía WebSocket
    if (this.websocketsService) {
      this.websocketsService.emitUserEvent(targetUser.id, 'payment:updated', {
        orderId: transaction.purchaseNumber,
        amountPen: Number(transaction.amountPen),
        tokenAmount: Number(transaction.tokenAmount),
        status: 'Pago Confirmado - Recarga en proceso',
      });
    }

    return 'OK';
  }

  /**
   * Genera la vista HTML responsiva con Krypton JS (V4) para el WebView móvil
   */
  async renderCheckoutPage(orderId: string): Promise<string> {
    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: orderId },
    });

    if (!transaction || transaction.status !== 'PENDING') {
      return `
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Sesión Expirada - Livora</title>
          <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:40px;background:#FEF2F2;color:#991B1B;}</style>
        </head>
        <body>
          <h3>Sesión de pago no válida o ya procesada</h3>
          <p>Por favor regresa a la app Livora para reintentar la operación.</p>
        </body>
        </html>
      `;
    }

    const publicKey = this.izipayClient.getPublicKey();
    const formToken = transaction.transactionToken || '';
    const amountFormatted = Number(transaction.amountPen).toFixed(2);

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Izipay Pago Seguro - Livora</title>
  
  <!-- Estilos Neon y SDK de Krypton V4 de Izipay -->
  <link rel="stylesheet" href="https://static.micuentaweb.pe/static/js/krypton-client/V4.0/ext/neon-reset.min.css">
  <script type="text/javascript" src="https://static.micuentaweb.pe/static/js/krypton-client/V4.0/ext/neon.js"></script>
  <script type="text/javascript"
    src="https://static.micuentaweb.pe/static/js/krypton-client/V4.0/stable/kr-payment-form.min.js"
    kr-public-key="${publicKey}"
    kr-post-url-success="/pago-exitoso">
  </script>

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #F8FAFC;
      color: #0F172A;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      min-height: 100vh;
      padding: 16px 12px;
    }
    .container {
      background: #FFFFFF;
      border-radius: 20px;
      padding: 20px 16px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05);
      border: 1px solid #E2E8F0;
      text-align: center;
    }
    .brand {
      font-size: 22px;
      font-weight: 800;
      color: #15803D;
      letter-spacing: -0.5px;
      margin-bottom: 4px;
    }
    .subtitle {
      font-size: 13px;
      color: #64748B;
      margin-bottom: 16px;
    }
    .card-amount {
      background: #F0FDF4;
      border: 1px solid #BBF7D0;
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 18px;
    }
    .amount-value {
      font-size: 26px;
      font-weight: 900;
      color: #14532D;
    }
    .token-value {
      font-size: 12.5px;
      font-weight: 600;
      color: #16A34A;
      margin-top: 4px;
    }
    .kr-smart-form {
      margin-top: 8px;
      width: 100%;
    }
    .footer-note {
      font-size: 11px;
      color: #94A3B8;
      margin-top: 16px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">Livora</div>
    <div class="subtitle">Pasarela de Pago Segura Izipay</div>

    <div class="card-amount">
      <div class="amount-value">S/ ${amountFormatted} PEN</div>
      <div class="token-value">Acredita: ${amountFormatted} LIVOs (1 PEN = 1 LIVO)</div>
    </div>

    <!-- Contenedor del Formulario Inteligente Krypton V4 de Izipay -->
    <div class="kr-smart-form" kr-form-token="${formToken}"></div>

    <div class="footer-note">
      Transacción protegida por Izipay con estándares internacionales PCI-DSS y 3D-Secure.
    </div>
  </div>

  <script>
    function notifyFlutter(payload) {
      try {
        if (window.IzipayBridge && window.IzipayBridge.postMessage) {
          window.IzipayBridge.postMessage(JSON.stringify(payload));
        } else {
          window.location.href = 'livora://payment-callback?data=' + encodeURIComponent(JSON.stringify(payload));
        }
      } catch (e) {
        window.location.href = 'livora://payment-callback?data=' + encodeURIComponent(JSON.stringify(payload));
      }
    }

    window.addEventListener('DOMContentLoaded', function() {
      if (typeof KR !== 'undefined') {
        KR.onSubmit(function(response) {
          if (response.clientAnswer && response.clientAnswer.orderStatus === 'PAID') {
            notifyFlutter({
              event: 'success',
              orderId: '${orderId}',
              clientAnswer: response.clientAnswer
            });
            return false;
          } else {
            notifyFlutter({
              event: 'error',
              orderId: '${orderId}',
              message: 'El pago no pudo ser completado'
            });
            return false;
          }
        });

        KR.onError(function(error) {
          notifyFlutter({
            event: 'error',
            orderId: '${orderId}',
            message: error.errorMessage || 'Error al procesar el pago con Izipay'
          });
        });
      }
    });
  </script>
</body>
</html>
    `;
  }

  /**
   * Historial de recargas de un usuario (exclusivo RECOLECTOR / TIENDA)
   */
  async getUserTransactions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== Role.RECOLECTOR && user.role !== Role.TIENDA) {
      throw new ForbiddenException(
        'El rol actual no opera con recargas fiduciarias vía pasarela',
      );
    }

    const txs = await this.prisma.paymentTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        purchaseNumber: true,
        amountPen: true,
        tokenAmount: true,
        status: true,
        blockchainStatus: true,
        cardBrand: true,
        cardPanMasked: true,
        authorizationCode: true,
        txHash: true,
        createdAt: true,
      },
    });

    return txs.map((tx) => {
      let friendlyStatus = 'Pendiente';
      if (tx.status === 'COMPLETED') {
        friendlyStatus =
          tx.blockchainStatus === 'MINTED'
            ? 'Completado'
            : 'Pago Confirmado - Recarga en proceso';
      } else if (tx.status === 'FAILED') {
        friendlyStatus = 'Rechazado';
      }

      return {
        ...tx,
        friendlyStatus,
      };
    });
  }
}
