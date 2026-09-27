import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushNotificationProcessor } from './push-notification.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketsModule } from '../websockets/websockets.module';
import { PUSH_NOTIFICATIONS_QUEUE } from './notifications.constants';

@Module({
  imports: [
    PrismaModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: PUSH_NOTIFICATIONS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, PushNotificationProcessor],
  exports: [NotificationsService, BullModule],
})
export class NotificationsModule {}
