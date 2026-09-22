import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedemptionStatus } from '@prisma/client';

@Injectable()
export class RedemptionExpirationWorker {
  private readonly logger = new Logger(RedemptionExpirationWorker.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tarea periódica de alta frecuencia (cada minuto) para expirar códigos QR de canje
   * que tengan más de 15 minutos de antigüedad sin confirmación. Ejecutada en livora_worker.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpirePendingRedemptions() {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const result = await this.prisma.redemptionTransaction.updateMany({
      where: {
        status: RedemptionStatus.PENDING,
        createdAt: {
          lt: fifteenMinutesAgo,
        },
      },
      data: {
        status: RedemptionStatus.EXPIRED,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `[CRON REDEMPTIONS] Se marcaron ${result.count} códigos QR pendientes como EXPIRED (>15m).`,
      );
    }
  }
}
