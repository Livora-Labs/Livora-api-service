import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
  ) {}

  private get reader() {
    return this.prisma.read || this.prisma;
  }

  async getHouseholdMetrics(userId: string) {
    const totalRequests = await this.reader.collectionRequest.count({
      where: { householdId: userId },
    });
    const completedRequests = await this.reader.collectionRequest.findMany({
      where: {
        householdId: userId,
        status: 'COMPLETED',
      },
      include: {
        batch: true,
      },
    });

    let totalRecycledKg = 0;
    const materialBreakdown: Record<string, number> = {};

    for (const r of completedRequests) {
      if (r.batch?.status === 'RECEIVED') {
        const mats = (r.batch.materialsActual as Record<string, number>) || {};
        const siblings = await this.reader.collectionRequest.count({
          where: { batchId: r.batchId },
        });
        const divisor = siblings || 1;

        for (const [mat, wt] of Object.entries(mats)) {
          const userWt = wt / divisor;
          totalRecycledKg += userWt;
          const normalized = mat.toUpperCase();
          materialBreakdown[normalized] = Number(
            ((materialBreakdown[normalized] || 0) + userWt).toFixed(2),
          );
        }
      } else {
        const mats =
          (r.actualWeights as Record<string, number>) ||
          (r.itemsEstimated as Record<string, number>) ||
          {};
        for (const [mat, rawWt] of Object.entries(mats)) {
          const userWt =
            typeof rawWt === 'number' ? rawWt : parseFloat(String(rawWt)) || 0;
          totalRecycledKg += userWt;
          const normalized = mat.toUpperCase();
          materialBreakdown[normalized] = Number(
            ((materialBreakdown[normalized] || 0) + userWt).toFixed(2),
          );
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
      materialBreakdown,
    };
  }

  async getCollectorReputation(userId: string) {
    const collector = await this.reader.user.findUnique({
      where: { id: userId },
      select: { reputationScore: true, totalRatings: true, requiresQaReview: true },
    });

    const totalPickups = await this.reader.collectionRequest.count({
      where: { collectorId: userId, status: 'COMPLETED' },
    });
    const assignedPickups = await this.reader.collectionRequest.count({
      where: { collectorId: userId },
    });

    const completionRate =
      assignedPickups > 0 ? totalPickups / assignedPickups : 1.0;
    const score = collector?.reputationScore ?? (totalPickups > 0 ? Number((4.0 + completionRate).toFixed(1)) : 5.0);
    const ratingCount = collector?.totalRatings ?? totalPickups;
    const badge =
      totalPickups >= 50
        ? 'MASTER_COLLECTOR'
        : totalPickups >= 10
          ? 'EXPERT_COLLECTOR'
          : totalPickups > 0
            ? 'VERIFIED_COLLECTOR'
            : 'NEW_COLLECTOR';

    return {
      collectorId: userId,
      score: Math.min(5.0, score),
      totalPickups,
      ratingCount,
      requiresQaReview: collector?.requiresQaReview ?? false,
      badge,
    };
  }

  async getB2bEsgMetrics(userId: string) {
    const sales = await this.reader.sale.findMany({
      where: { buyerId: userId },
    });

    let totalKg = 0;
    for (const s of sales) {
      totalKg += Number(s.weightKg) || 0;
    }

    const certificatesCount = await this.reader.certificate.count({
      where: { buyerId: userId, status: 'ACTIVE' },
    });

    return {
      buyerId: userId,
      co2SavedKg: Number((totalKg * 2.5).toFixed(2)),
      waterSavedLiters: Math.round(totalKg * 4.5),
      recycledMaterialsTotalKg: Number(totalKg.toFixed(2)),
      certificatesCount,
    };
  }

  async getAdminMetrics() {
    const totalUsers = await this.reader.user.count();
    const totalRequests = await this.reader.collectionRequest.count();
    const totalBatches = await this.reader.batch.count();

    const completedReqs = await this.reader.collectionRequest.findMany({
      where: { status: 'COMPLETED' },
      select: { actualWeights: true, itemsEstimated: true },
    });
    let realTotalKg = 0;
    for (const r of completedReqs) {
      const w =
        (r.actualWeights as Record<string, number>) ||
        (r.itemsEstimated as Record<string, number>) ||
        {};
      for (const val of Object.values(w)) {
        realTotalKg +=
          typeof val === 'number' ? val : parseFloat(String(val)) || 0;
      }
    }

    return {
      totalUsers,
      totalRequests,
      totalBatches,
      systemHealth: 'OPTIMAL',
      totalRecycledKg: Number(realTotalKg.toFixed(2)),
      activeNodes: 1,
    };
  }
}
