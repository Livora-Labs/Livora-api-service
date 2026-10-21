/**
 * Parámetros para la creación de una orden/sesión en la pasarela de pagos.
 */
export interface PaymentOrderParams {
  amountInSoles: number;
  orderId: string;
  customerEmail: string;
  userWalletAddress?: string;
  userId?: string;
}

/**
 * Resultado de la inicialización de sesión en la pasarela.
 */
export interface PaymentOrderResult {
  formToken: string;
  orderId: string;
  amountInSoles: number;
}

/**
 * Resultado estructurado y normalizado de la verificación de un Webhook / IPN.
 */
export interface IPNVerificationResult {
  isValid: boolean;
  orderId?: string;
  isPaid: boolean;
  orderStatus: string;
  amountPen?: number;
  cardBrand?: string;
  cardPanMasked?: string | null;
  authorizationCode?: string | null;
  rawPayload: any;
  errorMessage?: string;
}

/**
 * Patrón Adapter / Gateway (PUCP Disoft Diapositiva 05 y 09)
 * Desacopla la lógica de liquidación y reglas de negocio fiduciarias de los detalles
 * criptográficos (HMAC-SHA256) y esquemas propietarios de cada proveedor (Izipay, Niubiz, Stripe).
 */
export interface IPaymentGatewayAdapter {
  createPaymentSession(params: PaymentOrderParams): Promise<PaymentOrderResult>;
  verifyAndParseIpn(dto: Record<string, any>): IPNVerificationResult;
  getPublicKey(): string;
  getGatewayIdentifier(): string;
}
