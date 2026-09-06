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
import { NiubizClient } from './services/niubiz.client';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { ProcessPaymentWebhookDto } from './dto/process-payment-webhook.dto';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';
import * as crypto from 'crypto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly niubizClient: NiubizClient,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly notificationsService: NotificationsService,
    private readonly websocketsService: WebsocketsService,
    @Optional()
    @InjectQueue(BLOCKCHAIN_QUEUE)
    private readonly blockchainQueue?: Queue,
  ) {}

  /**
   * Genera una sesión de pago con Niubiz exclusiva para HOGAR y RECOLECTOR
   */
  async createSession(
    userId: string,
    dto: CreatePaymentSessionDto,
    clientIp?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { kycApplications: { take: 1, orderBy: { createdAt: 'desc' } } },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // Regla de arquitectura: Exclusividad para HOGAR y RECOLECTOR
    if (user.role !== Role.HOGAR && user.role !== Role.RECOLECTOR) {
      throw new ForbiddenException(
        'El rol actual no opera con recargas fiduciarias vía pasarela',
      );
    }

    // Purchase number correlativo único de 12 dígitos
    const purchaseNumber = `${Date.now()}`.slice(-12);

    // Registrar transacción en estado PENDING con subestado blockchain PENDING
    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        userId,
        amountPen: dto.amount,
        tokenAmount: dto.amount, // 1 PEN = 1 EcoToken
        purchaseNumber,
        status: 'PENDING',
        blockchainStatus: 'PENDING',
      },
    });

    const kycStatus = user.kycApplications?.[0]?.status || 'UNVERIFIED';

    const session = await this.niubizClient.createSession({
      amount: dto.amount,
      purchaseNumber,
      clientIp: clientIp || '190.236.10.15',
      userEmail: user.email,
      userId: user.id,
      kycStatus,
    });

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        transactionToken: session.sessionToken,
      },
    });

    return {
      transactionId: transaction.id,
      purchaseNumber,
      amount: dto.amount,
      tokenAmount: dto.amount,
      sessionToken: session.sessionToken,
      merchantId: session.merchantId,
    };
  }

  /**
   * Confirmación autenticada invocada desde la app móvil con transactionToken
   */
  async confirmPayment(userId: string, dto: ConfirmPaymentDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== Role.HOGAR && user.role !== Role.RECOLECTOR) {
      throw new ForbiddenException(
        'El rol actual no opera con recargas fiduciarias vía pasarela',
      );
    }

    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: dto.purchaseNumber },
      include: { user: true },
    });

    if (!transaction) {
      throw new NotFoundException(
        `Transacción con número de compra ${dto.purchaseNumber} no encontrada`,
      );
    }

    if (transaction.userId !== userId) {
      throw new ForbiddenException('La transacción no pertenece al usuario autenticado');
    }

    if (transaction.status === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        message: 'La transacción ya había sido confirmada previamente',
        transactionId: transaction.id,
        purchaseNumber: transaction.purchaseNumber,
        amountPen: Number(transaction.amountPen),
        tokenAmount: Number(transaction.tokenAmount),
      };
    }

    if (transaction.status === 'FAILED') {
      throw new BadRequestException('Esta transacción ya fue rechazada previamente');
    }

    // Autorización directa y sin bypass ante Niubiz
    const authResult = await this.niubizClient.authorizeTransaction(
      dto.transactionToken,
      transaction.purchaseNumber,
      Number(transaction.amountPen),
    );

    if (!authResult.authorized) {
      await this.prisma.$executeRaw`
        UPDATE payment_transactions
        SET status = 'FAILED'::"PaymentStatus",
            "actionCode" = ${authResult.actionCode || '999'},
            "gatewayResponse" = ${JSON.stringify(authResult.raw || {})}::jsonb,
            "updatedAt" = NOW()
        WHERE id = ${transaction.id}::uuid AND status = 'PENDING'::"PaymentStatus"
      `;
      throw new BadRequestException(
        `Autorización de pago denegada: ${authResult.description || 'Tarjeta rechazada o fondos insuficientes'}`,
      );
    }

    // Cálculo contable de comisión Niubiz (~3.45% + 18% IGV sobre comisión)
    const amountNum = Number(transaction.amountPen);
    const commissionPen = parseFloat((amountNum * 0.0345).toFixed(2));
    const igvPen = parseFloat((commissionPen * 0.18).toFixed(2));

    // Transición atómica SQL anti-TOCTOU PENDING -> COMPLETED
    const rowsAffected = await this.prisma.$executeRaw`
      UPDATE payment_transactions
      SET status = 'COMPLETED'::"PaymentStatus",
          "cardBrand" = ${authResult.cardBrand || null},
          "cardPanMasked" = ${authResult.cardPanMasked || null},
          "authorizationCode" = ${authResult.authorizationCode || null},
          "actionCode" = ${authResult.actionCode || '000'},
          "traceNumber" = ${authResult.traceNumber || null},
          "commissionPen" = ${commissionPen},
          "igvPen" = ${igvPen},
          "gatewayResponse" = ${JSON.stringify(authResult.raw || {})}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${transaction.id}::uuid AND status = 'PENDING'::"PaymentStatus"
    `;

    if (rowsAffected === 0) {
      this.logger.warn(
        `[ANTI-TOCTOU] Transacción ${transaction.purchaseNumber} ya fue procesada concurrentemente`,
      );
      return {
        status: 'COMPLETED',
        message: 'La transacción ya había sido confirmada previamente',
        transactionId: transaction.id,
      };
    }

    // Encolar minteo asíncrono en BullMQ con reintentos exponenciales
    let txHash: string | null = null;
    const targetUser = transaction.user;

    if (targetUser.walletAddress) {
      try {
        if (this.blockchainQueue) {
          const job = await this.blockchainQueue.add(
            'niubiz-mint-tokens',
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
          txHash = `job-${job.id}`;
        } else {
          // Ejecución directa si no hay cola activa
          const receipt = await this.blockchainService.mintEcoTokens(
            targetUser.walletAddress,
            Number(transaction.tokenAmount),
          );
          txHash = receipt?.hash || null;
        }
      } catch (mintErr: any) {
        this.logger.error(
          `Error al mintear tokens para recarga ${transaction.purchaseNumber}: ${mintErr.message}`,
        );
      }
    }

    if (txHash) {
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: { txHash, blockchainStatus: 'MINTED' },
      });
    }

    // Notificar al usuario
    this.notificationsService
      .sendPushNotification(
        targetUser.id,
        'Recarga de EcoTokens exitosa',
        `Se han acreditado ${Number(transaction.tokenAmount).toFixed(2)} EcoTokens en tu monedero tras tu pago de S/ ${Number(transaction.amountPen).toFixed(2)} PEN.`,
        { purchaseNumber: transaction.purchaseNumber },
      )
      .catch(() => {});

    return {
      status: 'COMPLETED',
      amountPen: Number(transaction.amountPen),
      tokenAmount: Number(transaction.tokenAmount),
      purchaseNumber: transaction.purchaseNumber,
      authorizationCode: authResult.authorizationCode,
      cardBrand: authResult.cardBrand,
      cardPanMasked: authResult.cardPanMasked,
      txHash,
    };
  }

  /**
   * Procesa el webhook server-to-server firmado con HMAC-SHA256
   */
  async processWebhook(dto: ProcessPaymentWebhookDto) {
    const webhookSecret =
      this.configService.get<string>('PAYMENT_WEBHOOK_SECRET') ||
      'livora_niubiz_webhook_secret_2026';

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(dto.purchaseNumber)
      .digest('hex');

    const signatureBuffer = Buffer.from(dto.signature || '', 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      signatureBuffer.length === 0 ||
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      this.logger.error(
        `Firma de webhook inválida para compra ${dto.purchaseNumber}. Firma recibida: ${dto.signature}`,
      );
      throw new BadRequestException('Firma HMAC de webhook Niubiz inválida');
    }

    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: dto.purchaseNumber },
      include: { user: true },
    });

    if (!transaction) {
      throw new NotFoundException(
        `Transacción con número de compra ${dto.purchaseNumber} no encontrada`,
      );
    }

    if (transaction.status === 'COMPLETED') {
      return {
        status: 'COMPLETED',
        message: 'La transacción ya había sido procesada previamente',
        transactionId: transaction.id,
      };
    }

    // Si el webhook provee transactionToken y está PENDING, autorizar con Niubiz
    if (dto.transactionToken && transaction.status === 'PENDING') {
      const authResult = await this.niubizClient.authorizeTransaction(
        dto.transactionToken,
        transaction.purchaseNumber,
        Number(transaction.amountPen),
      );

      if (!authResult.authorized) {
        await this.prisma.$executeRaw`
          UPDATE payment_transactions
          SET status = 'FAILED'::"PaymentStatus",
              "actionCode" = ${authResult.actionCode || '999'},
              "gatewayResponse" = ${JSON.stringify(authResult.raw || {})}::jsonb,
              "updatedAt" = NOW()
          WHERE id = ${transaction.id}::uuid AND status = 'PENDING'::"PaymentStatus"
        `;
        throw new BadRequestException('Autorización de pago denegada por Niubiz');
      }

      await this.prisma.$executeRaw`
        UPDATE payment_transactions
        SET status = 'COMPLETED'::"PaymentStatus",
            "cardBrand" = ${authResult.cardBrand || null},
            "cardPanMasked" = ${authResult.cardPanMasked || null},
            "authorizationCode" = ${authResult.authorizationCode || null},
            "actionCode" = ${authResult.actionCode || '000'},
            "traceNumber" = ${authResult.traceNumber || null},
            "gatewayResponse" = ${JSON.stringify(authResult.raw || {})}::jsonb,
            "updatedAt" = NOW()
        WHERE id = ${transaction.id}::uuid AND status = 'PENDING'::"PaymentStatus"
      `;
    }

    return {
      status: 'COMPLETED',
      purchaseNumber: transaction.purchaseNumber,
      amountPen: transaction.amountPen,
    };
  }

  /**
   * Genera la vista HTML responsiva para el Checkout de Niubiz embebido en Flutter
   */
  async renderCheckoutPage(purchaseNumber: string): Promise<string> {
    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber },
    });

    if (!transaction || transaction.status !== 'PENDING') {
      return `
        <!DOCTYPE html>
        <html lang="es">
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sesión Expirada</title>
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#fef2f2;color:#991b1b;}</style></head>
        <body><h3>Sesión de pago no válida o ya procesada</h3><p>Por favor regresa a la app Livora para reintentar.</p></body></html>
      `;
    }

    const isSandbox =
      this.configService.get<string>('NIUBIZ_ENV', 'sandbox') === 'sandbox';
    const scriptUrl = isSandbox
      ? 'https://static-content-qas.vnforapps.com/v2/js/checkout.js'
      : 'https://static-content.vnforapps.com/v2/js/checkout.js';

    const merchantId = this.niubizClient.getMerchantId();
    const sessionToken = transaction.transactionToken || '';
    const amountFormatted = Number(transaction.amountPen).toFixed(2);

    return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Niubiz Pago Seguro - Livora</title>
  <script src="${scriptUrl}"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #F8FAFC;
      color: #0F172A;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .container {
      background: #FFFFFF;
      border-radius: 20px;
      padding: 24px;
      max-width: 380px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.06);
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
      margin-bottom: 20px;
    }
    .card-amount {
      background: #F0FDF4;
      border: 1px solid #BBF7D0;
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 24px;
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
    .btn-pay {
      background: #0284C7;
      color: #FFFFFF;
      border: none;
      border-radius: 14px;
      padding: 15px;
      font-size: 15px;
      font-weight: 700;
      width: 100%;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.25);
      transition: background 0.2s ease;
    }
    .btn-pay:hover { background: #0369A1; }
    .footer-note {
      font-size: 11px;
      color: #94A3B8;
      margin-top: 20px;
      line-height: 1.4;
    }
    .status-msg {
      margin-top: 14px;
      font-size: 12px;
      color: #0284C7;
      font-weight: 600;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">Livora</div>
    <div class="subtitle">Pasarela de Pago Segura Niubiz</div>
    
    <div class="card-amount">
      <div class="amount-value">S/ ${amountFormatted} PEN</div>
      <div class="token-value">Acredita: ${amountFormatted} EcoTokens (1 PEN = 1 ECO)</div>
    </div>

    <button id="btnPay" class="btn-pay" onclick="openNiubizCheckout()">
      Abrir Pasarela de Pago
    </button>
    <div id="statusMsg" class="status-msg">Iniciando formulario seguro de pago...</div>

    <div class="footer-note">
      Cifrado bancario seguro PCI-DSS con autenticación 3D Secure 2.0.
    </div>
  </div>

  <script>
    function notifyFlutter(payload) {
      if (window.NiubizBridge && window.NiubizBridge.postMessage) {
        window.NiubizBridge.postMessage(JSON.stringify(payload));
      } else {
        window.location.href = 'livora://payment-callback?data=' + encodeURIComponent(JSON.stringify(payload));
      }
    }

    function openNiubizCheckout() {
      const statusEl = document.getElementById('statusMsg');
      if (statusEl) statusEl.style.display = 'block';

      try {
        if (typeof VisanetCheckout === 'undefined') {
          notifyFlutter({ event: 'error', message: 'No se pudo cargar la librería de Niubiz Checkout' });
          return;
        }

        VisanetCheckout.configure({
          sessiontoken: '${sessionToken}',
          channel: 'web',
          merchantid: '${merchantId}',
          purchasenumber: '${purchaseNumber}',
          amount: '${amountFormatted}',
          expirationminutes: '20',
          timeouturl: 'about:blank',
          merchantlogo: 'https://livora.pe/icon.png',
          formbuttoncolor: '#0284C7',
          complete: function(params) {
            if (params && params.transactionToken) {
              notifyFlutter({
                event: 'success',
                purchaseNumber: '${purchaseNumber}',
                transactionToken: params.transactionToken
              });
            } else {
              notifyFlutter({
                event: 'error',
                message: 'No se recibió token de transacción de Niubiz'
              });
            }
          }
        });
        VisanetCheckout.open();
      } catch (err) {
        notifyFlutter({ event: 'error', message: err.message || 'Error al desplegar formulario Niubiz' });
      }
    }

    window.addEventListener('load', function() {
      setTimeout(openNiubizCheckout, 300);
    });
  </script>
</body>
</html>
    `;
  }

  /**
   * Historial de recargas de un usuario (exclusivo HOGAR / RECOLECTOR)
   */
  async getUserTransactions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== Role.HOGAR && user.role !== Role.RECOLECTOR) {
      throw new ForbiddenException(
        'El rol actual no opera con recargas fiduciarias vía pasarela',
      );
    }

    return this.prisma.paymentTransaction.findMany({
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
  }
}
