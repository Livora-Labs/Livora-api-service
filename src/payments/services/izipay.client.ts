import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface IzipayCreatePaymentParams {
  amountInSoles: number;
  orderId: string;
  customerEmail: string;
  userWalletAddress?: string;
  userId?: string;
}

export interface IzipayCreatePaymentResponse {
  formToken: string;
  orderId: string;
  amountInSoles: number;
}

@Injectable()
export class IzipayClient {
  private readonly logger = new Logger(IzipayClient.name);
  private readonly shopId: string;
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly sha256Key: string;
  private readonly endpoint: string;

  constructor(private readonly configService: ConfigService) {
    this.shopId =
      this.configService.get<string>('IZIPAY_SHOP_ID') || '88005980';
    this.privateKey =
      this.configService.get<string>('IZIPAY_PRIVATE_KEY') ||
      'testpassword_o5W2Sl1fbtpODUVCcGr6D5HHPjEGD3Ve8FBuXG3T6rJLH';
    this.publicKey =
      this.configService.get<string>('IZIPAY_PUBLIC_KEY') ||
      '88005980:testpublickey_wThHD6SclqjUR7rAAlualxADxSeHgmP6027bT97P3ZVTg';
    this.sha256Key =
      this.configService.get<string>('IZIPAY_SHA256_KEY') ||
      'VhoR0lSG9MmDZdIuA0nrmJrQOGQOrObXFxWGL1XwjJw72';
    this.endpoint =
      this.configService.get<string>('IZIPAY_API_ENDPOINT') ||
      'https://api.micuentaweb.pe/api-payment/V4/Charge/CreatePayment';
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  getShopId(): string {
    return this.shopId;
  }

  private isTestEnv(): boolean {
    return (
      process.env.NODE_ENV === 'test' ||
      this.configService.get<string>('NODE_ENV') === 'test'
    );
  }

  /**
   * Invoca la API REST V4 de Izipay para generar el formToken de la pasarela Krypton
   */
  async createPaymentToken(
    params: IzipayCreatePaymentParams,
  ): Promise<IzipayCreatePaymentResponse> {
    const amountInCents = Math.round(params.amountInSoles * 100);

    const payload = {
      amount: amountInCents,
      currency: 'PEN',
      orderId: params.orderId,
      customer: {
        email: params.customerEmail,
      },
      metadata: {
        userId: params.userId,
        walletAddress: params.userWalletAddress || '',
        ecotokensAmount: params.amountInSoles,
      },
    };

    if (this.isTestEnv() && (!this.shopId || !this.privateKey || this.privateKey === 'mock_test')) {
      return {
        formToken: `mock_form_token_${params.orderId}`,
        orderId: params.orderId,
        amountInSoles: params.amountInSoles,
      };
    }

    try {
      const auth = Buffer.from(`${this.shopId}:${this.privateKey}`).toString(
        'base64',
      );

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const responseData = await response.json();

      if (!response.ok || responseData.status !== 'SUCCESS') {
        const errorMsg =
          responseData?.answer?.errorMessage ||
          responseData?.message ||
          `HTTP ${response.status}`;
        this.logger.error(
          `[IzipayClient] Error creando orden en Izipay (${params.orderId}): ${errorMsg}`,
        );
        throw new BadGatewayException(
          `Error al comunicarse con la pasarela de pagos Izipay: ${errorMsg}`,
        );
      }

      const formToken = responseData.answer?.formToken;
      if (!formToken) {
        this.logger.error(
          `[IzipayClient] Respuesta de Izipay no contiene formToken para orden ${params.orderId}`,
        );
        throw new BadGatewayException(
          'La pasarela de pagos no retornó el token de formulario requerido',
        );
      }

      return {
        formToken,
        orderId: params.orderId,
        amountInSoles: params.amountInSoles,
      };
    } catch (error: any) {
      if (error instanceof BadGatewayException) throw error;
      this.logger.error(
        `[IzipayClient] Excepción de conexión hacia Izipay: ${error.message}`,
      );
      throw new BadGatewayException(
        'Servicio de pasarela Izipay temporalmente no disponible',
      );
    }
  }

  /**
   * Valida la firma HMAC-SHA256 de una notificación IPN de Izipay
   */
  verifyHmac(
    rawAnswer: string | object,
    receivedHash: string,
    hashKeyType?: string,
  ): boolean {
    if (!receivedHash) return false;

    const answerStr =
      typeof rawAnswer === 'string' ? rawAnswer : JSON.stringify(rawAnswer);

    // Si Izipay especifica kr-hash-key === 'password', se usa la contraseña de API REST
    // Si especifica 'sha256_hmac' o por defecto, se usa la clave HMAC-SHA256
    const key = hashKeyType === 'password' ? this.privateKey : this.sha256Key;

    const calculatedHash = crypto
      .createHmac('sha256', key)
      .update(answerStr, 'utf8')
      .digest('hex');

    try {
      const calculatedBuf = Buffer.from(calculatedHash, 'hex');
      const receivedBuf = Buffer.from(receivedHash, 'hex');

      if (calculatedBuf.length !== receivedBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(calculatedBuf, receivedBuf);
    } catch {
      return false;
    }
  }
}
