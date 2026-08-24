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
    this.senderEmail = this.configService.get<string>(
      'BREVO_SENDER_EMAIL',
      'info@livora.org',
    );
    this.senderName = this.configService.get<string>(
      'BREVO_SENDER_NAME',
      'Libora',
    );

    if (apiKey && apiKey !== 'xkeysib-placeholder') {
      try {
        this.mailApi = new BrevoClient({ apiKey });
        this.logger.log('Brevo MailService inicializado con éxito');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error inicializando Brevo API: ${msg}`);
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
    const subject = 'Código de verificación Livora';
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
            <a href="https://livora.org" class="logo">LIVORA</a>
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
    const subject = '¡Bienvenido a Livora!';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Bienvenido a Livora</title>
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
            <a href="https://livora.org" class="logo">LIVORA</a>
          </div>
          <div class="content">
            <h2>¡Hola!</h2>
            <p>Gracias por unirte a la red de economía circular <strong>Livora</strong>.</p>
            <p>Con Livora puedes gestionar y trazar la entrega de material reciclable, y ganar recompensas (EcoTokens) directo en la blockchain de Stellar.</p>
            <p>Estamos emocionados de tenerte a bordo para fomentar la sostenibilidad y la transparencia ambiental.</p>
            <a href="https://livora.org" class="btn">Explorar la Plataforma</a>
          </div>
          <div class="footer">
            <p>Este es un correo automático. Por favor no respondas a este mensaje.</p>
            <p>&copy; ${new Date().getFullYear()} Livora S.A.C. Todos los derechos reservados.</p>
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
  async sendSystemNotification(
    toEmail: string,
    title: string,
    bodyText: string,
  ): Promise<void> {
    const subject = `Notificación de Livora: ${title}`;
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
            <a href="https://livora.org" class="logo">LIVORA</a>
          </div>
          <div class="content">
            <h2>${title}</h2>
            <p>${bodyText}</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Livora S.A.C. Todos los derechos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.sendMail(toEmail, subject, htmlContent);
  }

  /**
   * Envía la confirmación del Libro de Reclamaciones con la Hoja de Reclamación en PDF adjunta.
   */
  async sendComplaintConfirmationEmail(
    toEmail: string,
    fullName: string,
    correlativeNumber: string,
    claimType: string,
    pdfBuffer: Buffer,
  ): Promise<void> {
    const isReclamo = claimType.toUpperCase() === 'RECLAMO';
    const tipoTexto = isReclamo ? 'Reclamo' : 'Queja';
    const subject = `Copia de Hoja de Reclamación ${correlativeNumber} - Livora`;
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Libro de Reclamaciones - Livora</title>
        <style>
          body { font-family: sans-serif; background-color: #121212; color: #E0E0E0; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1E1E1E; border-radius: 12px; padding: 30px; border: 1px solid #2C2C2C; }
          .header { text-align: center; border-bottom: 2px solid #2E7D32; padding-bottom: 15px; }
          .logo { font-size: 24px; font-weight: bold; color: #81C784; text-decoration: none; }
          .content { padding-top: 20px; line-height: 1.6; }
          .badge { display: inline-block; padding: 6px 12px; background-color: #2E7D32; color: #FFFFFF; border-radius: 4px; font-weight: bold; font-size: 16px; margin: 10px 0; }
          .info-box { background-color: #2A2A2A; border-left: 4px solid #81C784; padding: 15px; margin: 20px 0; border-radius: 4px; }
          .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #757575; border-top: 1px solid #2C2C2C; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <a href="https://livora.org" class="logo">LIVORA</a>
          </div>
          <div class="content">
            <h2>Constancia de Recepción de ${tipoTexto}</h2>
            <p>Estimado(a) <strong>${fullName}</strong>,</p>
            <p>Hemos recibido satisfactoriamente su ${tipoTexto.toLowerCase()} a través de nuestro <strong>Libro de Reclamaciones Virtual</strong>.</p>
            <div class="info-box">
              <p style="margin: 0 0 8px 0;"><strong>Código Correlativo:</strong></p>
              <div class="badge">${correlativeNumber}</div>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #B0BEC5;">Guarde este número para dar seguimiento a su solicitud.</p>
            </div>
            <p>Conforme a la normativa vigente de protección al consumidor (Ley N° 29571 y Ley N° 32495 / Indecopi), le informamos que su ${tipoTexto.toLowerCase()} será atendido en un plazo máximo de <strong>15 días hábiles</strong> no prorrogables.</p>
            <p>Adjunto a este correo encontrará una copia en formato PDF de su <strong>Hoja de Reclamación</strong> con todos los detalles registrados.</p>
          </div>
          <div class="footer">
            <p>Este es un correo automático generado por el Libro de Reclamaciones Virtual de Livora S.A.C.</p>
            <p>&copy; ${new Date().getFullYear()} Livora. Todos los derechos reservados.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const attachment = [
      {
        content: pdfBuffer.toString('base64'),
        name: `Hoja-Reclamacion-${correlativeNumber}.pdf`,
      },
    ];

    await this.sendMail(toEmail, subject, htmlContent, attachment);
  }

  /**
   * Envía un correo con el enlace para restablecer la contraseña.
   */
  async sendPasswordRecoveryEmail(
    toEmail: string,
    resetLink: string,
  ): Promise<void> {
    const subject = 'Restablecer contraseña - Livora';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Restablecer contraseña - Livora</title>
        <style>
          body { font-family: Arial, sans-serif; background-color: #0A192F; color: #F8FAFC; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #0D1117; border-radius: 12px; padding: 40px; border: 1px solid #1E293B; }
          .header { text-align: center; border-bottom: 2px solid #10B981; padding-bottom: 20px; }
          .logo { font-size: 26px; font-weight: 800; color: #10B981; text-decoration: none; letter-spacing: -0.5px; }
          .content { padding-top: 30px; line-height: 1.6; }
          .title { font-size: 20px; font-weight: 700; color: #F8FAFC; margin-bottom: 16px; }
          .button-container { text-align: center; margin: 30px 0; }
          .btn { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #10B981, #059669); color: #0A192F; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.1); }
          .link-text { word-break: break-all; color: #06B6D4; font-size: 13px; text-decoration: underline; }
          .warning { background-color: #1E293B; border-left: 4px solid #F59E0B; padding: 16px; border-radius: 6px; font-size: 13px; color: #94A3B8; margin-top: 24px; }
          .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #64748B; border-top: 1px solid #1E293B; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <span class="logo">LIVORA</span>
          </div>
          <div class="content">
            <div class="title">Solicitud de restablecimiento de contraseña</div>
            <p>Estimado usuario,</p>
            <p>Hemos recibido una solicitud para restablecer la contraseña asociada a su cuenta en la plataforma de economía circular Livora.</p>
            <p>Para continuar con el proceso y definir una nueva contraseña, por favor haga clic en el siguiente enlace:</p>
            <div class="button-container">
              <a href="${resetLink}" class="btn" target="_blank">Restablecer contraseña</a>
            </div>
            <p>Si el botón no funciona, también puede copiar y pegar la siguiente dirección en su navegador web:</p>
            <p><a href="${resetLink}" class="link-text" target="_blank">${resetLink}</a></p>
            <div class="warning">
              Por motivos de seguridad, este enlace es de uso único y tiene una validez de 1 hora. Si usted no ha solicitado este restablecimiento, puede ignorar este mensaje; su contraseña actual permanecerá segura.
            </div>
          </div>
          <div class="footer">
            <p>Este es un mensaje automático del sistema de seguridad de Livora S.A.C.</p>
            <p>&copy; ${new Date().getFullYear()} Livora. Todos los derechos reservados.</p>
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
  private async sendMail(
    toEmail: string,
    subject: string,
    htmlContent: string,
    attachment?: Array<{ content: string; name: string }>,
  ): Promise<void> {
    if (!this.mailApi) {
      this.logger.log(
        `[SIMULACIÓN CORREO] Para: ${toEmail} | Asunto: ${subject}${attachment ? ` | Adjuntos: ${attachment.map((a) => a.name).join(', ')}` : ''}`,
      );
      return;
    }

    try {
      await this.mailApi.transactionalEmails.sendTransacEmail({
        subject,
        htmlContent,
        sender: { name: this.senderName, email: this.senderEmail },
        to: [{ email: toEmail }],
        attachment,
      });
      this.logger.log(`Correo enviado con éxito a ${toEmail}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error enviando correo transaccional Brevo: ${msg}`);
    }
  }
}
