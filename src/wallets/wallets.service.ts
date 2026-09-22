import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
  ) {}

  /**
   * GET /wallets/me/balance
   * Consulta directa al Smart Contract en Stellar/Soroban
   */
  async getBalance(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (!user.walletAddress) {
      return { balance: '0.00' };
    }

    // 1. Calculate spent EcoTokens from completed redemption transactions
    const redemptions = await this.prisma.redemptionTransaction.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { tokenAmount: true },
    });
    const totalSpent = redemptions.reduce((sum, r) => sum + Number(r.tokenAmount), 0);

    // 2. Try to get on-chain balance first
    const contractId = this.configService.get<string>('ECOTOKEN_CONTRACT_ID');
    if (contractId && contractId !== 'C...') {
      try {
        const onChainBalanceStr = await this.blockchainService.getBalance(
          user.walletAddress,
        );
        const onChainBalance = parseFloat(onChainBalanceStr);
        if (onChainBalance > 0) {
          const finalBalance = Math.max(0, onChainBalance - totalSpent);
          return { balance: finalBalance.toFixed(2) };
        }
      } catch (error: any) {
        this.logger.error(
          `Error al consultar balance Soroban on-chain: ${error.message}`,
        );
      }
    }

    // 3. Fallback: calculate off-chain ledger balance dynamically based on DB rewards and redemptions
    let totalEarned = 0;
    if (user.role === 'RECOLECTOR') {
      const batches = await this.prisma.batch.findMany({
        where: { collectorId: userId, status: 'RECEIVED' },
      });
      for (const b of batches) {
        const mats = (b.materialsActual as Record<string, number>) || {};
        let batchTotal = 0;
        for (const [mat, wt] of Object.entries(mats)) {
          const rate = await this.blockchainService.getMaterialRate(mat);
          batchTotal += wt * rate;
        }
        const reqs = await this.prisma.collectionRequest.findMany({
          where: { batchId: b.id },
        });
        if (reqs.length === 0) {
          totalEarned += batchTotal;
        } else {
          totalEarned += batchTotal * 0.2;
        }
      }
    } else if (user.role === 'HOGAR') {
      const reqs = await this.prisma.collectionRequest.findMany({
        where: {
          householdId: userId,
          status: 'COMPLETED',
        },
        include: { batch: true },
      });
      for (const r of reqs) {
        if (r.batch?.status === 'RECEIVED') {
          const mats =
            (r.batch.materialsActual as Record<string, number>) || {};
          let batchTotal = 0;
          for (const [mat, wt] of Object.entries(mats)) {
            const rate = await this.blockchainService.getMaterialRate(mat);
            batchTotal += wt * rate;
          }
          const siblings = await this.prisma.collectionRequest.count({
            where: { batchId: r.batchId },
          });
          const divisor = siblings || 1;
          totalEarned += (batchTotal * 0.8) / divisor;
        } else {
          const actualWeights =
            (r.actualWeights as Record<string, number>) ||
            (r.itemsEstimated as Record<string, number>) ||
            {};
          const agreedRates = (r.agreedRates as Record<string, number>) || {};
          let reqTotal = 0;
          for (const [mat, rawWt] of Object.entries(actualWeights)) {
            const wt = typeof rawWt === 'number' ? rawWt : parseFloat(String(rawWt)) || 0;
            const rate = agreedRates[mat] || agreedRates[mat.toUpperCase()] || (await this.blockchainService.getMaterialRate(mat));
            reqTotal += wt * rate;
          }
          totalEarned += reqTotal * 0.40;
        }
      }
    } else if (user.role === 'TIENDA') {
      const storeProfile = await this.prisma.storeProfile.findFirst({
        where: { userId: user.id },
      });
      if (storeProfile) {
        const redemptions = await this.prisma.redemptionTransaction.findMany({
          where: { storeId: storeProfile.id, status: 'COMPLETED' },
          select: { tokenAmount: true },
        });
        totalEarned = redemptions.reduce((sum, r) => sum + Number(r.tokenAmount), 0);
      }
    }

    const payments = await this.prisma.paymentTransaction.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { tokenAmount: true },
    });
    const totalPayments = payments.reduce((sum, p) => sum + Number(p.tokenAmount), 0);
    totalEarned += totalPayments;

    const finalBalance = Math.max(0, totalEarned - totalSpent);
    return { balance: finalBalance.toFixed(2) };
  }

  /**
   * POST /wallets/transactions
   * El backend actúa como Relayer (Gas Subsidiado) construyendo una FeeBumpTransaction
   * firmada por el usuario en la transacción interna y subsidiada por la wallet relayer en la externa.
   */
  async sendTransaction(userId: string, dto: CreateTransactionDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (!user.encryptedPrivateKey) {
      throw new BadRequestException(
        'El usuario no posee una clave privada registrada para firmar la transacción',
      );
    }

    const encryptionKey =
      this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
      this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'CRITICAL SECURITY ERROR: La variable WALLET_ENCRYPTION_KEY es obligatoria para firmar transacciones Web3.',
      );
    }
    const finalKey = encryptionKey || 'test_isolated_wallet_encryption_key_32c';
    const userSecretKey = CryptoUtil.decrypt(
      user.encryptedPrivateKey,
      finalKey,
    );
    if (!userSecretKey) {
      throw new BadRequestException(
        'No se pudo descifrar la clave privada del usuario',
      );
    }

    const receipt = await this.blockchainService.executeSubsidizedTransfer(
      userSecretKey,
      dto.toAddress,
      dto.amount,
    );

    return {
      status: 'PROCESSING',
      transactionId: receipt.hash,
      message:
        'Transacción subsidiada por el Relayer y enviada a la red Stellar Testnet',
      fromUser: user.email,
      toAddress: dto.toAddress,
      amount: dto.amount,
    };
  }

  async getTransactionHistory(
    userId: string,
    page = 1,
    limit = 15,
    direction?: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const txs: any[] = [];

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
        amount: r.tokenAmount,
        direction: 'OUT',
        recipientName: r.store.businessName || r.store.user.email.split('@')[0],
        recipientWallet:
          r.store.user.walletAddress ||
          'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        txHash: r.txHash || null,
        createdAt: r.updatedAt,
      });
    }

    const defaultRates: Record<string, number> = {
      PET: 1.0,
      PAPEL: 0.5,
      CARTON: 0.5,
      'CARTÓN': 0.5,
      VIDRIO: 0.3,
      PLASTICO: 1.0,
      'PLÁSTICO': 1.0,
      ALUMINIO: 1.5,
      TETRAPAK: 0.4,
      HDPE: 1.0,
    };

    // 2. Fetch rewards from received batches
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
          const rate = defaultRates[mat.toUpperCase()] || 1.0;
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
              defaultRates[mat.toUpperCase()] ||
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
              defaultRates[mat.toUpperCase()] ||
              1.0;
            reqTotal += wt * rate;
          }
          const isDonation = (r as any).isDonation;
          const rewardAmount = isDonation
            ? 0
            : Number((r as any).householdRewardEarned) || reqTotal * 0.4;
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

    // Filter by direction if specified
    const filtered =
      direction && direction !== 'TODAS'
        ? txs.filter((t) => t.direction === direction)
        : txs;

    // Sort by date descending
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
