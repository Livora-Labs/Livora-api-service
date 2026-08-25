import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
  ) {}

  async getHouseholdMetrics(userId: string) {
    const totalRequests = await this.prisma.collectionRequest.count({
      where: { householdId: userId },
    });
    const completedRequests = await this.prisma.collectionRequest.findMany({
      where: {
        householdId: userId,
        status: 'COMPLETED',
        batchId: { not: null },
      },
      include: {
        batch: true,
      },
    });

    let totalRecycledKg = 0;
    for (const r of completedRequests) {
      if (r.batch?.status === 'RECEIVED') {
        const mats = (r.batch.materialsActual as Record<string, number>) || {};
        const siblings = await this.prisma.collectionRequest.count({
          where: { batchId: r.batchId },
        });
        const divisor = siblings || 1;

        for (const wt of Object.values(mats)) {
          totalRecycledKg += wt / divisor;
        }
      }
    }

    const balanceRes = await this.walletsService.getBalance(userId);
    const balance = parseFloat(balanceRes.balance) || 0.0;

    return {
      householdId: userId,
      totalRequests,
      completedRequests: completedRequests.length,
      totalRecycledKg: Number(totalRecycledKg.toFixed(2)),
      ecoTokensEarned: balance,
    };
  }

  async getCollectorReputation(userId: string) {
    return {
      collectorId: userId,
      score: 4.8,
      totalPickups: 35,
      ratingCount: 28,
      badge: 'VERIFIED_COLLECTOR',
    };
  }

  async getB2bEsgMetrics(userId: string) {
    return {
      buyerId: userId,
      co2SavedKg: 1250.0,
      waterSavedLiters: 4500,
      recycledMaterialsTotalKg: 890.5,
      certificatesCount: 4,
    };
  }

  async getAdminMetrics() {
    const totalUsers = await this.prisma.user.count();
    const totalRequests = await this.prisma.collectionRequest.count();
    const totalBatches = await this.prisma.batch.count();

    return {
      totalUsers,
      totalRequests,
      totalBatches,
      systemHealth: 'OPTIMAL',
      totalRecycledKg: totalRequests * 12.5,
      activeNodes: 1,
    };
  }
}
