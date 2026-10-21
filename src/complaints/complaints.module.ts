import { Module } from '@nestjs/common';
import { ComplaintsController } from './complaints.controller';
import { ComplaintsService } from './complaints.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailService } from '../common/services/mail.service';
import { TurnstileService } from '../common/services/turnstile.service';
import { ComplaintPdfKitAdapter } from './adapters/complaint-pdfkit.adapter';

@Module({
  imports: [PrismaModule],
  controllers: [ComplaintsController],
  providers: [ComplaintsService, MailService, TurnstileService, ComplaintPdfKitAdapter],
  exports: [ComplaintsService, ComplaintPdfKitAdapter],
})
export class ComplaintsModule {}
