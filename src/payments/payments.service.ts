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

import { IPaymentGatewayAdapter } from './adapters/payment-gateway.adapter.interface';
import { IzipayPaymentAdapter } from './adapters/izipay-payment.adapter';
import { CheckoutViewRenderer } from './renderers/checkout-view.renderer';

/**
 * Servicio de Pagos y Liquidaciones Fiduciarias (PUCP Disoft - GoF Adapter + Presentation Separation)
 * Administra las reglas de negocio, límites diarios, idempotencia y minteo on-chain,
 * delegando la criptografía y comunicación con Izipay al Adapter (IPaymentGatewayAdapter)
 * y la renderización visual de formularios a CheckoutViewRenderer.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly gatewayAdapter: IPaymentGatewayAdapter;
  private readonly viewRenderer: CheckoutViewRenderer;

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
    @Optional() gatewayAdapter?: IzipayPaymentAdapter,
    @Optional() viewRenderer?: CheckoutViewRenderer,
  ) {
    this.gatewayAdapter = gatewayAdapter ?? new IzipayPaymentAdapter(this.izipayClient);
    this.viewRenderer = viewRenderer ?? new CheckoutViewRenderer();
  }

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

    // Límite diario acumulado de S/ 500.00 PEN en las últimas 24 horas
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

    const orderId = `ECO-${Date.now()}-${user.id.slice(0, 4).toUpperCase()}`;

    const transaction = await this.prisma.paymentTransaction.create({
      data: {
        userId,
        amountPen: effectiveAmount,
        tokenAmount: effectiveAmount,
        purchaseNumber: orderId,
        status: 'PENDING',
        blockchainStatus: 'PENDING',
      },
    });

    const email = dto.customerEmail || user.email;
    const wallet = dto.userWalletAddress || user.walletAddress || undefined;

    const sessionRes = await this.gatewayAdapter.createPaymentSession({
      amountInSoles: effectiveAmount,
      orderId,
      customerEmail: email,
      userWalletAddress: wallet,
      userId: user.id,
    });

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        transactionToken: sessionRes.formToken,
      },
    });

    return {
      success: true,
      orderId,
      amount: effectiveAmount,
      currency: 'PEN',
      formToken: sessionRes.formToken,
    };
  }

  /**
   * Procesa la notificación instantánea de pago (IPN / Webhook)
   */
  async processIzipayIpn(dto: IzipayIpnDto | Record<string, any>): Promise<string> {
    const verification = this.gatewayAdapter.verifyAndParseIpn(dto);
    const orderId = verification.orderId!;

    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: orderId },
      include: { user: true },
    });

    if (!transaction) {
      this.logger.warn(`[Izipay IPN] Transacción con orderId ${orderId} no encontrada en BD`);
      throw new NotFoundException(`Transacción ${orderId} no encontrada`);
    }

    // Idempotencia: Si ya fue completada, responder OK
    if (transaction.status === 'COMPLETED') {
      this.logger.log(`[Izipay IPN] Transacción ${orderId} ya procesada previamente (Idempotencia)`);
      return 'OK';
    }

    if (!verification.isPaid) {
      this.logger.warn(
        `[Izipay IPN] Orden ${orderId} recibida con estado no pagado: ${verification.orderStatus}`,
      );
      await this.prisma.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          gatewayResponse: verification.rawPayload,
        },
      });
      return 'OK';
    }

    // Marcar como COMPLETED en BD
    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        cardBrand: verification.cardBrand,
        cardPanMasked: verification.cardPanMasked,
        authorizationCode: verification.authorizationCode,
        gatewayResponse: verification.rawPayload,
      },
    });

    // Ejecutar o encolar Minteo on-chain en Stellar/Soroban
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

        if (this.mailService) {
          await this.mailService.sendAccreditationAlertToAdmin({
            adminEmail: 'danielarmando023@gmail.com',
            purchaseNumber: transaction.purchaseNumber,
            userEmail: targetUser.email,
            userName: targetUser.name || 'Usuario Livora',
            amountPen: Number(transaction.amountPen),
            tokenAmount: Number(transaction.tokenAmount),
            cardBrand: verification.cardBrand || 'CARD',
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
          cardBrand: verification.cardBrand || 'CARD',
          errorMessage: 'El usuario no tiene una cuenta de monedero vinculada para acreditar saldo.',
        }).catch(() => {});
      }
    }

    this.notificationsService
      .sendPushNotification(
        targetUser.id,
        'Pago confirmado – Recarga en proceso',
        `Se ha confirmado tu pago de S/ ${Number(transaction.amountPen).toFixed(2)} PEN. Tus ${Number(transaction.tokenAmount).toFixed(2)} LIVOs se reflejarán en tu saldo disponible en unos instantes.`,
        { purchaseNumber: transaction.purchaseNumber },
      )
      .catch(() => {});

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
   * Genera la vista HTML responsiva para el WebView móvil
   * Delega la presentación a CheckoutViewRenderer (PUCP Disoft Diapositiva 07).
   */
  async renderCheckoutPage(orderId: string): Promise<string> {
    const transaction = await this.prisma.paymentTransaction.findUnique({
      where: { purchaseNumber: orderId },
    });

    if (!transaction || transaction.status !== 'PENDING') {
      return this.viewRenderer.renderExpiredSessionPage();
    }

    const publicKey = this.gatewayAdapter.getPublicKey();
    const formToken = transaction.transactionToken || '';
    const amountFormatted = Number(transaction.amountPen).toFixed(2);

    return this.viewRenderer.renderCheckoutPage(publicKey, formToken, amountFormatted);
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
