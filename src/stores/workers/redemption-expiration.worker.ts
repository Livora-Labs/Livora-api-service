import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedemptionStatus } from '@prisma/client';

@Injectable()
export class RedemptionExpirationWorker {
  private readonly logger = new Logger(RedemptionExpirationWorker.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tarea periódica horaria para expirar transacciones de canje (QR) pendientes
   * que tengan más de 24 horas de antigüedad. Ejecutada exclusivamente en livora_worker.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleExpirePendingRedemptions() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.prisma.redemptionTransaction.updateMany({
      where: {
        status: RedemptionStatus.PENDING,
        createdAt: {
          lt: twentyFourHoursAgo,
        },
      },
      data: {
        status: RedemptionStatus.EXPIRED,
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `[CRON REDEMPTIONS] Se marcaron ${result.count} códigos QR pendientes como EXPIRED (>24h).`,
      );
    }
  }
}
