import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResultDto } from '../../common/dto/paginated-result.dto';

export interface WalletTransactionItem {
  id: string;
  type: string;
  amount: number;
  direction: 'IN' | 'OUT';
  recipientName: string;
  recipientWallet: string;
  txHash: string | null;
  ipfsCid?: string | null;
  createdAt: Date;
}

const DEFAULT_RATES: Record<string, number> = {
  PET: 1.0,
  PAPEL: 0.5,
  CARTON: 0.5,
  CARTÓN: 0.5,
  VIDRIO: 0.3,
  PLASTICO: 1.0,
  PLÁSTICO: 1.0,
  ALUMINIO: 1.5,
  TETRAPAK: 0.4,
  HDPE: 1.0,
};

/**
 * Servicio Agregador de Historial de Transacciones (PUCP Disoft - Aggregator Pattern)
 * Centraliza la agregación poli-fuente de transacciones off-chain y on-chain:
 * canjes en tiendas, recompensas de reciclaje, donaciones y transferencias P2P.
 */
@Injectable()
export class WalletHistoryAggregatorService {
  constructor(private readonly prisma: PrismaService) {}

  async getTransactionHistory(
    userId: string,
    page = 1,
    limit = 15,
    direction?: string,
  ): Promise<PaginatedResultDto<WalletTransactionItem>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const txs: WalletTransactionItem[] = [];

    // 1. Fetch completed store redemptions
    const redemptions = await this.prisma.redemptionTransaction.findMany({
      where: { userId, status: 'COMPLETED' },
      include: {
        store: {
          include: {
            user: {
              select: { email: true, walletAddress: true },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    for (const r of redemptions) {
      txs.push({
        id: r.id,
        type: 'PAGO_TIENDA',
        amount: Number(r.tokenAmount),
        direction: 'OUT',
        recipientName: r.store.businessName || r.store.user.email.split('@')[0],
        recipientWallet:
          r.store.user.walletAddress ||
          'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        txHash: r.txHash || null,
        createdAt: r.updatedAt,
      });
    }

    // 2. Fetch rewards from recycling batches / requests
    if (user.role === 'RECOLECTOR') {
      const batches = await this.prisma.batch.findMany({
        where: { collectorId: userId, status: 'RECEIVED' },
        include: {
          destinationCenter: { select: { email: true, walletAddress: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });

      for (const b of batches) {
        const mats = (b.materialsActual as Record<string, number>) || {};
        let batchTotal = 0;
        for (const [mat, wt] of Object.entries(mats)) {
          const rate = DEFAULT_RATES[mat.toUpperCase()] || 1.0;
          batchTotal += wt * rate;
        }

        const reqs = await this.prisma.collectionRequest.findMany({
          where: { batchId: b.id },
        });
        const rewardAmount = reqs.length === 0 ? batchTotal : batchTotal * 0.2;

        txs.push({
          id: b.id,
          type: 'RECOMPENSA_RECICLAJE',
          amount: Number(rewardAmount.toFixed(2)),
          direction: 'IN',
          recipientName: 'Sistema Livora (LIVOs)',
          recipientWallet:
            b.destinationCenter?.walletAddress ||
            'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
          txHash: b.txHash || null,
          ipfsCid: b.ipfsCid || null,
          createdAt: b.updatedAt,
        });
      }
    } else if (user.role === 'HOGAR') {
      const reqs = await this.prisma.collectionRequest.findMany({
        where: {
          householdId: userId,
          status: 'COMPLETED',
        },
        include: {
          batch: {
            include: {
              destinationCenter: {
                select: { email: true, walletAddress: true },
              },
            },
          },
          collector: {
            select: { name: true, walletAddress: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      for (const r of reqs) {
        const agreedRates = (r.agreedRates as Record<string, number>) || {};
        if (r.batch?.status === 'RECEIVED') {
          const mats =
            (r.batch.materialsActual as Record<string, number>) || {};
          let batchTotal = 0;
          for (const [mat, wt] of Object.entries(mats)) {
            const rate =
              agreedRates[mat] ||
              agreedRates[mat.toUpperCase()] ||
              DEFAULT_RATES[mat.toUpperCase()] ||
              1.0;
            batchTotal += wt * rate;
          }

          const siblings = await this.prisma.collectionRequest.count({
            where: { batchId: r.batchId },
          });
          const divisor = siblings || 1;
          const rewardAmount = (batchTotal * 0.8) / divisor;

          txs.push({
            id: r.id,
            type: 'RECOMPENSA_RECICLAJE',
            amount: Number(rewardAmount.toFixed(2)),
            direction: 'IN',
            recipientName: 'Sistema Livora (LIVOs)',
            recipientWallet:
              r.batch.destinationCenter?.walletAddress ||
              'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
            txHash: (r as any).txHash || r.batch.txHash || null,
            ipfsCid: r.batch.ipfsCid || null,
            createdAt: r.batch.updatedAt,
          });
        } else {
          const weights =
            (r.actualWeights as Record<string, number>) ||
            (r.itemsEstimated as Record<string, number>) ||
            {};
          let reqTotal = 0;
          for (const [mat, rawWt] of Object.entries(weights)) {
            const wt =
              typeof rawWt === 'number'
                ? rawWt
                : parseFloat(String(rawWt)) || 0;
            const rate =
              agreedRates[mat] ||
              agreedRates[mat.toUpperCase()] ||
              DEFAULT_RATES[mat.toUpperCase()] ||
              1.0;
            reqTotal += wt * rate;
          }
          const isDonation = (r as any).isDonation;
          const rewardAmount = isDonation
            ? 0
            : Number((r as any).householdRewardEarned) || reqTotal * 0.25;
          if (rewardAmount > 0 || isDonation) {
            txs.push({
              id: r.id,
              type: isDonation ? 'DONACION_ECOLOGICA' : 'RECOMPENSA_RECICLAJE',
              amount: Number(rewardAmount.toFixed(2)),
              direction: 'IN',
              recipientName: isDonation
                ? 'Donación Ecológica (0 LIVOs)'
                : 'Sistema Livora (LIVOs)',
              recipientWallet:
                r.collector?.walletAddress ||
                'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
              txHash: (r as any).txHash || null,
              ipfsCid: null,
              createdAt: r.updatedAt,
            });
          }
        }
      }
    }

    // 3. P2P Transfers (sent and received)
    const sentTransfers = await this.prisma.walletTransfer.findMany({
      where: {
        senderUserId: userId,
        receiverUserId: { not: userId },
      },
      include: {
        receiver: { select: { name: true, email: true, walletAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const t of sentTransfers) {
      txs.push({
        id: t.id,
        type: 'TRANSFERENCIA_P2P',
        amount: Number(t.amount),
        direction: 'OUT',
        recipientName:
          t.receiver?.name ||
          t.receiver?.email?.split('@')[0] ||
          t.toAddress.slice(0, 8) + '...',
        recipientWallet: t.toAddress,
        txHash: t.txHash || null,
        createdAt: t.createdAt,
      });
    }

    const receivedTransfers = await this.prisma.walletTransfer.findMany({
      where: { receiverUserId: userId },
      include: {
        sender: { select: { name: true, email: true, walletAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const t of receivedTransfers) {
      const isForestReward = t.note?.startsWith('FOREST_');
      txs.push({
        id: t.id + '_recv',
        type: isForestReward ? 'RECOMPENSA_RECICLAJE' : 'TRANSFERENCIA_P2P',
        amount: Number(t.amount),
        direction: 'IN',
        recipientName: isForestReward
          ? 'Misión Mi Bosque (LIVOs)'
          : t.sender?.name ||
            t.sender?.email?.split('@')[0] ||
            t.fromAddress.slice(0, 8) + '...',
        recipientWallet: t.fromAddress,
        txHash: t.txHash || null,
        createdAt: t.createdAt,
      });
    }

    // 4. Direction filtering
    const filtered =
      direction && direction !== 'TODAS'
        ? txs.filter((t) => t.direction === direction)
        : txs;

    // 5. Date sorting descending & pagination
    const sorted = filtered.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const total = sorted.length;
    const skip = (page - 1) * limit;
    const paged = sorted.slice(skip, skip + limit);

    return new PaginatedResultDto(paged, total, page, limit);
  }
}
