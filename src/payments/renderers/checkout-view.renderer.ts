import { Injectable } from '@nestjs/common';

/**
 * Renderizador de Vistas de Checkout (PUCP Disoft Diapositiva 07 - Patrones Web y Presentación)
 * Aísla la generación de plantillas HTML y scripts del SDK de cliente Krypton V4 de la capa de servicios de dominio.
 */
@Injectable()
export class CheckoutViewRenderer {
  renderExpiredSessionPage(): string {
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

  renderCheckoutPage(publicKey: string, formToken: string, amountFormatted: string): string {
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
      background-color: #F8FAFC;
      color: #0F172A;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
    }
    .checkout-container {
      background: #FFFFFF;
      width: 100%;
      max-width: 420px;
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      padding: 24px;
      border: 1px solid #E2E8F0;
    }
    .brand-header {
      text-align: center;
      margin-bottom: 20px;
    }
    .brand-header h2 {
      font-size: 20px;
      font-weight: 700;
      color: #166534;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .order-summary {
      background-color: #F0FDF4;
      border: 1px dashed #86EFAC;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .order-summary .label {
      font-size: 13px;
      color: #166534;
      font-weight: 500;
    }
    .order-summary .amount {
      font-size: 18px;
      font-weight: 800;
      color: #15803D;
    }
    .kr-embedded {
      width: 100% !important;
    }
    .kr-payment-button {
      background: #16A34A !important;
      color: #FFFFFF !important;
      font-weight: 600 !important;
      border-radius: 10px !important;
      height: 48px !important;
      margin-top: 16px !important;
      border: none !important;
      box-shadow: 0 4px 6px -1px rgba(22, 163, 74, 0.2) !important;
      transition: all 0.2s ease !important;
    }
    .kr-payment-button:hover {
      background: #15803D !important;
    }
    .security-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 20px;
      font-size: 12px;
      color: #64748B;
    }
  </style>
</head>
<body>

  <div class="checkout-container">
    <div class="brand-header">
      <h2>🌱 Livora Pagos</h2>
      <p style="font-size: 13px; color: #64748B; margin-top: 4px;">Pasarela Segura Izipay (Krypton V4)</p>
    </div>

    <div class="order-summary">
      <div>
        <div class="label">Recarga de Saldo</div>
        <div style="font-size: 11px; color: #22C55E;">Conversión 1 PEN = 1 LIVO</div>
      </div>
      <div class="amount">S/ ${amountFormatted} PEN</div>
    </div>

    <!-- Formulario incrustado de Izipay -->
    <div class="kr-embedded" kr-form-token="${formToken}">
      <div class="kr-pan"></div>
      <div class="kr-expiry"></div>
      <div class="kr-security-code"></div>
      <button class="kr-payment-button"></button>
      <div class="kr-form-error"></div>
    </div>

    <div class="security-badge">
      🔒 Transacción cifrada TLS con estándar PCI-DSS
    </div>
  </div>

  <script type="text/javascript">
    KR.onError(function(event) {
      console.error("[Krypton V4] Error en pago:", event);
      if (window.IzipayBridge && window.IzipayBridge.postMessage) {
        window.IzipayBridge.postMessage(JSON.stringify({ status: "ERROR", error: event }));
      }
    });

    KR.onSubmit(function(response) {
      console.log("[Krypton V4] Pago procesado por el cliente:", response);
      if (response.clientAnswer && response.clientAnswer.orderStatus === "PAID") {
        if (window.IzipayBridge && window.IzipayBridge.postMessage) {
          window.IzipayBridge.postMessage(JSON.stringify({ status: "SUCCESS", data: response }));
        }
      }
    });
  </script>
</body>
</html>
    `;
  }
}
