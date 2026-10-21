import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { IzipayClient } from './services/izipay.client';
import { PrismaModule } from '../prisma/prisma.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { BLOCKCHAIN_QUEUE } from '../blockchain/blockchain.constants';
import { MailService } from '../common/services/mail.service';

// Patrones de diseño de pagos (PUCP Disoft - GoF Adapter & Presentation Separation)
import { IzipayPaymentAdapter } from './adapters/izipay-payment.adapter';
import { CheckoutViewRenderer } from './renderers/checkout-view.renderer';

@Module({
  imports: [
    PrismaModule,
    BlockchainModule,
    NotificationsModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: BLOCKCHAIN_QUEUE,
    }),
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    IzipayClient,
    MailService,
    IzipayPaymentAdapter,
    CheckoutViewRenderer,
  ],
  exports: [
    PaymentsService,
    IzipayClient,
    MailService,
    IzipayPaymentAdapter,
    CheckoutViewRenderer,
  ],
})
export class PaymentsModule {}
