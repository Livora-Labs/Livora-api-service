import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getHouseholdMetrics(userId: string) {
    const totalRequests = await this.prisma.collectionRequest.count({
      where: { householdId: userId },
    });
    const completedRequests = await this.prisma.collectionRequest.count({
      where: { householdId: userId, status: 'COMPLETED' },
    });

    return {
      householdId: userId,
      totalRequests,
      completedRequests,
      totalRecycledKg: completedRequests * 4.5,
      ecoTokensEarned: completedRequests * 15,
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
