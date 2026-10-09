import { Module } from '@nestjs/common';
import { ComplaintsController } from './complaints.controller';
import { ComplaintsService } from './complaints.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailService } from '../common/services/mail.service';
import { TurnstileService } from '../common/services/turnstile.service';

@Module({
  imports: [PrismaModule],
  controllers: [ComplaintsController],
  providers: [ComplaintsService, MailService, TurnstileService],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
