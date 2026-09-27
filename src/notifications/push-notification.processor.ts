import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PUSH_NOTIFICATIONS_QUEUE } from './notifications.constants';
import { NotificationsService } from './notifications.service';

export interface PushNotificationJobData {
  type: 'user' | 'topic';
  userId?: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

@Processor(PUSH_NOTIFICATIONS_QUEUE, { concurrency: 10 })
export class PushNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(PushNotificationProcessor.name);

  constructor(private readonly notificationsService: NotificationsService) {
    super();
  }

  async process(job: Job<PushNotificationJobData>): Promise<void> {
    const { type, userId, topic, title, body, data } = job.data;
    if (type === 'topic' && topic) {
      await this.notificationsService.executeTopicNotification(topic, title, body, data);
    } else if (type === 'user' && userId) {
      await this.notificationsService.executePushNotification(userId, title, body, data);
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Job Push #${job.id} despachado exitosamente.`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `Job Push #${job.id} falló en intento ${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
