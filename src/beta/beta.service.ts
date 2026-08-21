import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/services/mail.service';

@Injectable()
export class BetaService {
  private readonly logger = new Logger(BetaService.name);
  private readonly notifyTo: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {
    this.notifyTo = this.configService.get<string>(
      'BETA_NOTIFY_TO',
      'ciriacodeveloper@gmail.com',
    );
  }

  async register(email: string): Promise<void> {
    const signup = await this.prisma.betaSignup.create({ data: { email } });
    this.logger.log(`Nuevo registro beta: ${email} (${signup.id})`);

    try {
      await this.mailService.sendWelcomeEmail(email);
      await this.mailService.sendSystemNotification(
        this.notifyTo,
        '♻️ Nuevo registro beta LIVORA',
        `Nuevo interesado en la beta de LIVORA:\n\nEmail: ${email}\nFecha: ${signup.createdAt.toISOString()}\nID: ${signup.id}`,
      );
      this.logger.log(`Notificación enviada a ${this.notifyTo}`);
    } catch (error: any) {
      this.logger.error(
        `Fallo enviando notificación de beta: ${error.message}`,
      );
    }
  }
}
