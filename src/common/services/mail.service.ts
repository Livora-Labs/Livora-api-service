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
    const subject = 'Código de verificación Livora 🔑';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Código OTP - Livora</title>
        <style>
          body { font-family: sans-serif; background-color: #121212; color: #E0E0E0; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1E1E1E; border-radius: 12px; padding: 30px; border: 1px solid #2C2C2C; }
          .header { text-align: center; border-bottom: 2px solid #2E7D32; padding-bottom: 15px; }
          .logo { font-size: 24px; font-weight: bold; color: #81C784; text-decoration: none; }
          .content { padding-top: 20px; line-height: 1.6; text-align: center; }
          .otp-code { font-size: 32px; font-weight: bold; color: #81C784; letter-spacing: 4px; margin: 20px 0; background: #2C2C2C; padding: 15px; border-radius: 8px; display: inline-block; }
          .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #757575; border-top: 1px solid #2C2C2C; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="https://livora.org" class="logo">♻️ LIVORA</a>
          </div>
          <div class="content">
            <h2>Código de Verificación</h2>
            <p>Usa el siguiente código de verificación para completar tu registro en Livora. Este código expirará en 10 minutos.</p>
            <div class="otp-code">${otp}</div>
            <p>Si no solicitaste este código, puedes ignorar este correo de forma segura.</p>
          </div>
          <div class="footer">
            <p>Este es un correo automático. Por favor no respondas a este mensaje.</p>
            <p>&copy; ${new Date().getFullYear()} Livora. Todos los derechos reservados.</p>
          </div>
        </div>
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
