import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BrevoClient } from '@getbrevo/brevo';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly mailApi: BrevoClient | null = null;
  private readonly senderEmail: string;
  private readonly senderName: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('BREVO_API_KEY');
    this.senderEmail = this.configService.get<string>('BREVO_SENDER_EMAIL', 'info@livora.org');
    this.senderName = this.configService.get<string>('BREVO_SENDER_NAME', 'Libora');

    if (apiKey && apiKey !== 'xkeysib-placeholder') {
      try {
        this.mailApi = new BrevoClient({ apiKey });
        this.logger.log('Brevo MailService inicializado con éxito');
      } catch (err: any) {
        this.logger.error(`Error inicializando Brevo API: ${err.message}`);
      }
    } else {
      this.logger.warn(
        'BREVO_API_KEY no está configurada o usa placeholder. Los correos se imprimirán en los logs en su lugar.',
      );
    }
  }

  /**
   * Envía el código de verificación OTP.
   */
  async sendOtpEmail(toEmail: string, otp: string): Promise<void> {
    const subject = 'Tu código de verificación · Livora';
    // El logo DEBE estar alojado en una URL pública HTTPS (los clientes de correo
    // bloquean imágenes en base64). Configurable con EMAIL_LOGO_URL.
    const logoUrl = this.configService.get<string>(
      'EMAIL_LOGO_URL',
      'https://52.200.2.107.sslip.io/assets/livora-logo.png',
    );
    const year = new Date().getFullYear();
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="dark light">
        <title>Código de verificación · Livora</title>
      </head>
      <body style="margin:0;padding:0;background-color:#0e1512;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0e1512;padding:32px 16px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#161f1b;border:1px solid #24312b;border-radius:16px;overflow:hidden;">
                <tr>
                  <td align="center" style="padding:28px 32px;background-color:#ffffff;">
                    <img src="${logoUrl}" alt="Livora — Reciclaje verificado. Valor real." width="190" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:190px;">
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:36px 32px 6px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#eaf4f0;">Código de verificación</h1>
                    <p style="margin:0 auto;max-width:340px;font-size:14px;line-height:1.6;color:#9bb0a6;">Usa este código para completar tu registro en Livora. Vence en <strong style="color:#cfe3d8;">10 minutos</strong>.</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:26px 32px;">
                    <div style="display:inline-block;background-color:#0e1512;border:1px solid #2f7d54;border-radius:12px;padding:16px 26px;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:700;letter-spacing:10px;color:#5fce97;">${otp}</div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 32px 34px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    <p style="margin:0 auto;max-width:340px;font-size:12px;line-height:1.6;color:#6f8479;">Si no solicitaste este código, ignora este correo de forma segura.</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:20px 32px;background-color:#111a16;border-top:1px solid #24312b;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 4px;font-size:11px;color:#5b6f65;">Correo automático · no respondas a este mensaje.</p>
                    <p style="margin:0;font-size:11px;color:#5b6f65;">© ${year} Livora · Reciclaje verificado</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    await this.sendMail(toEmail, subject, htmlContent);
  }

  /**
   * Envía un correo de confirmación de registro / bienvenida a la beta.
   */
  async sendWelcomeEmail(toEmail: string): Promise<void> {
    const subject = '¡Bienvenido a Libora! ♻️';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Bienvenido a Libora</title>
        <style>
          body { font-family: sans-serif; background-color: #121212; color: #E0E0E0; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1E1E1E; border-radius: 12px; padding: 30px; border: 1px solid #2C2C2C; }
          .header { text-align: center; border-bottom: 2px solid #2E7D32; padding-bottom: 15px; }
          .logo { font-size: 24px; font-weight: bold; color: #81C784; text-decoration: none; }
          .content { padding-top: 20px; line-height: 1.6; }
          .btn { display: inline-block; padding: 12px 24px; background-color: #2E7D32; color: #FFFFFF; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 15px; }
          .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #757575; border-top: 1px solid #2C2C2C; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="https://livora.org" class="logo">♻️ LIBORA</a>
          </div>
          <div class="content">
            <h2>¡Hola!</h2>
            <p>Gracias por unirte a la red de economía circular <strong>Libora</strong>.</p>
            <p>Con Libora puedes gestionar y trazar la entrega de material reciclable, y ganar recompensas (EcoTokens) directo en la blockchain de Arbitrum.</p>
            <p>Estamos emocionados de tenerte a bordo para fomentar la sostenibilidad y la transparencia ambiental.</p>
            <a href="https://livora.org" class="btn">Explorar la Plataforma</a>
          </div>
          <div class="footer">
            <p>Este es un correo automático. Por favor no respondas a este mensaje.</p>
            <p>&copy; ${new Date().getFullYear()} Libora. Todos los derechos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.sendMail(toEmail, subject, htmlContent);
  }

  /**
   * Envía una notificación general con plantilla responsiva.
   */
  async sendSystemNotification(toEmail: string, title: string, bodyText: string): Promise<void> {
    const subject = `Notificación de Libora: ${title}`;
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: sans-serif; background-color: #121212; color: #E0E0E0; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1E1E1E; border-radius: 12px; padding: 30px; border: 1px solid #2C2C2C; }
          .header { text-align: center; border-bottom: 2px solid #2E7D32; padding-bottom: 15px; }
          .logo { font-size: 24px; font-weight: bold; color: #81C784; text-decoration: none; }
          .content { padding-top: 20px; line-height: 1.6; }
          .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #757575; border-top: 1px solid #2C2C2C; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="https://livora.org" class="logo">♻️ LIBORA</a>
          </div>
          <div class="content">
            <h2>${title}</h2>
            <p>${bodyText}</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Libora. Todos los derechos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.sendMail(toEmail, subject, htmlContent);
  }

  /**
   * Helper privado para despachar correo vía SDK o simulación en logs.
   */
  private async sendMail(toEmail: string, subject: string, htmlContent: string): Promise<void> {
    if (!this.mailApi) {
      this.logger.log(`[SIMULACIÓN CORREO] Para: ${toEmail} | Asunto: ${subject}`);
      return;
    }

    try {
      await this.mailApi.transactionalEmails.sendTransacEmail({
        subject,
        htmlContent,
        sender: { name: this.senderName, email: this.senderEmail },
        to: [{ email: toEmail }],
      });
      this.logger.log(`Correo enviado con éxito a ${toEmail}`);
    } catch (err: any) {
      this.logger.error(`Error enviando correo transaccional Brevo: ${err.message}`);
    }
  }
}
