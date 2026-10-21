import {
  Injectable,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlockchainService } from '../../blockchain/services/blockchain.service';
import { RewardCalculatorFactory } from '../factories/reward-calculator.factory';

/**
 * Servicio de Garantía y Escrow (PUCP Disoft - Single Responsibility Principle)
 * Encapsula la verificación de KYC de recolectores y el cálculo y validación de fondos en custodia.
 */
@Injectable()
export class CollectionEscrowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchainService: BlockchainService,
    private readonly rewardFactory: RewardCalculatorFactory,
  ) {}

  /**
   * Valida que el recolector tenga su documentación KYC formalmente aprobada
   */
  async validateCollectorKyc(collectorId: string): Promise<void> {
    const collector = await this.prisma.user.findUnique({
      where: { id: collectorId },
      select: { kycStatus: true },
    });

    if (collector?.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(
        'Tu cuenta de recolector debe estar verificada administrativamente (KYC aprobado) antes de poder aceptar recolecciones en campo.',
      );
    }
  }

  /**
   * Calcula el monto de garantía requerido (Escrow) para una solicitud
   */
  calculateRequiredEscrow(
    itemsEstimated: Record<string, number>,
    agreedRates: Record<string, number>,
    isDonation: boolean = false,
  ): number {
    const strategy = this.rewardFactory.getStrategy(isDonation);
    const result = strategy.calculate(itemsEstimated, agreedRates, isDonation);
    return result.requiredEscrow;
  }

  /**
   * Valida la suficiencia de fondos (on-chain Stellar + depósitos Izipay) del recolector
   */
  async validateCollectorSolvency(
    collectorId: string,
    requiredEscrow: number,
  ): Promise<void> {
    if (requiredEscrow <= 0) return;

    const collector = await this.prisma.user.findUnique({
      where: { id: collectorId },
      select: { walletAddress: true },
    });

    let totalBalance = 0;
    if (collector?.walletAddress) {
      try {
        const balStr = await this.blockchainService.getBalance(collector.walletAddress);
        totalBalance = parseFloat(balStr) || 0;
      } catch {
        totalBalance = 0;
      }
    }

    // Fallback: Depósitos Izipay completados
    if (totalBalance === 0) {
      const payments = await this.prisma.paymentTransaction.findMany({
        where: { userId: collectorId, status: 'COMPLETED' },
        select: { tokenAmount: true },
      });
      totalBalance = payments.reduce((sum, p) => sum + Number(p.tokenAmount), 0);
    }

    // Calcular retenciones activas actualmente comprometidas
    const activeRequests = await this.prisma.collectionRequest.findMany({
      where: {
        collectorId,
        status: { in: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'] },
      },
      select: { escrowLocked: true },
    });
    const totalActiveEscrow = activeRequests.reduce(
      (sum, r) => sum + Number(r.escrowLocked),
      0,
    );

    const availableBalance = totalBalance - totalActiveEscrow;
    if (availableBalance < requiredEscrow) {
      throw new BadRequestException(
        `Saldo insuficiente para garantizar la recolección. Se requieren ${requiredEscrow.toFixed(2)} LIVOs en garantía (saldo disponible: ${Math.max(0, availableBalance).toFixed(2)} LIVOs).`,
      );
    }
  }
}
