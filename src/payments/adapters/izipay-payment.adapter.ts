import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  IPaymentGatewayAdapter,
  PaymentOrderParams,
  PaymentOrderResult,
  IPNVerificationResult,
} from './payment-gateway.adapter.interface';
import { IzipayClient } from '../services/izipay.client';

/**
 * Adaptador Concreto para Izipay Krypton V4 (PUCP Disoft - GoF Adapter Pattern)
 * Traduce las operaciones canónicas de pago hacia los métodos y formatos de la API REST V4 de Izipay.
 */
@Injectable()
export class IzipayPaymentAdapter implements IPaymentGatewayAdapter {
  private readonly logger = new Logger(IzipayPaymentAdapter.name);

  constructor(private readonly izipayClient: IzipayClient) {}

  getGatewayIdentifier(): string {
    return 'IZIPAY_KRYPTON_V4';
  }

  getPublicKey(): string {
    return this.izipayClient.getPublicKey();
  }

  async createPaymentSession(
    params: PaymentOrderParams,
  ): Promise<PaymentOrderResult> {
    const res = await this.izipayClient.createPaymentToken({
      amountInSoles: params.amountInSoles,
      orderId: params.orderId,
      customerEmail: params.customerEmail,
      userWalletAddress: params.userWalletAddress,
      userId: params.userId,
    });

    return {
      formToken: res.formToken,
      orderId: res.orderId,
      amountInSoles: res.amountInSoles,
    };
  }

  verifyAndParseIpn(dto: Record<string, any>): IPNVerificationResult {
    const krAnswerRaw = dto['kr-answer'];
    const krHash = dto['kr-hash'];

    if (!krAnswerRaw || !krHash) {
      this.logger.error('[Izipay IPN] Payload inválido: faltan kr-answer o kr-hash');
      throw new BadRequestException('Faltan parámetros requeridos de firma Izipay (kr-answer, kr-hash)');
    }

    const hashKeyType = dto['kr-hash-key'];
    const isSignatureValid = this.izipayClient.verifyHmac(krAnswerRaw, krHash, hashKeyType);
    if (!isSignatureValid) {
      this.logger.error('[Izipay IPN] Fallo de autenticación: Firma HMAC-SHA256 no coincide');
      throw new BadRequestException('Firma HMAC-SHA256 inválida');
    }

    const krAnswer =
      typeof krAnswerRaw === 'string' ? JSON.parse(krAnswerRaw) : krAnswerRaw;

    const orderId =
      krAnswer.orderDetails?.orderId ||
      krAnswer.orderId ||
      krAnswer.transactions?.[0]?.transactionDetails?.parentTransactionUuid;

    if (!orderId) {
      this.logger.error('[Izipay IPN] kr-answer no incluye orderDetails.orderId');
      throw new BadRequestException('No se pudo identificar el orderId de la transacción');
    }

    const orderStatus = krAnswer.orderStatus || 'UNKNOWN';
    const isPaid = orderStatus === 'PAID';

    const firstTx = krAnswer.transactions?.[0];
    const cardDetails = firstTx?.transactionDetails?.cardDetails;
    const cardBrand = cardDetails?.effectiveBrand || cardDetails?.paymentMethodType || 'CARD';
    const cardPanMasked = cardDetails?.pan || null;
    const authorizationCode =
      cardDetails?.authorizationResponse?.authorizationNumber ||
      firstTx?.uuid ||
      null;

    const rawAmount = krAnswer.orderDetails?.orderTotalAmount;
    const amountPen = rawAmount !== undefined ? Number(rawAmount) / 100 : undefined;

    return {
      isValid: true,
      orderId,
      isPaid,
      orderStatus,
      amountPen,
      cardBrand,
      cardPanMasked,
      authorizationCode,
      rawPayload: krAnswer,
    };
  }
}
