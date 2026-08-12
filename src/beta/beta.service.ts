import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BetaService {
  private readonly logger = new Logger(BetaService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly notifyTo: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.notifyTo = this.configService.get<string>(
      'BETA_NOTIFY_TO',
      'ciriacodeveloper@gmail.com',
    );

    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');

    if (smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
        port: this.configService.get<number>('SMTP_PORT', 465),
        secure: true,
        auth: { user: smtpUser, pass: smtpPass },
      });
      this.logger.log(`Notificaciones de beta activas hacia ${this.notifyTo}`);
    } else {
      this.logger.warn(
        'SMTP_USER/SMTP_PASS no configurados: los registros de beta se guardan en BD pero no se enviará correo.',
      );
    }
  }

  async register(email: string): Promise<void> {
    const signup = await this.prisma.betaSignup.create({ data: { email } });
    this.logger.log(`Nuevo registro beta: ${email} (${signup.id})`);

    if (!this.transporter) return;

    try {
      await this.transporter.sendMail({
        from: `"LIVORA Landing" <${this.configService.get<string>('SMTP_USER')}>`,
        to: this.notifyTo,
        subject: `♻️ Nuevo registro beta LIVORA: ${email}`,
        text: `Nuevo interesado en la beta de LIVORA:\n\nEmail: ${email}\nFecha: ${signup.createdAt.toISOString()}\nID: ${signup.id}`,
      });
      this.logger.log(`Notificación enviada a ${this.notifyTo}`);
    } catch (error: any) {
      // El registro ya está en BD; el fallo de correo no debe romper el flujo
      this.logger.error(`Fallo enviando notificación de beta: ${error.message}`);
    }
  }
}
