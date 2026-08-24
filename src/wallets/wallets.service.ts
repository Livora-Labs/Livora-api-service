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
    const totalSpent = redemptions.reduce((sum, r) => sum + r.tokenAmount, 0);

    // 2. Try to get on-chain balance first
    const contractId = this.configService.get<string>('ECOTOKEN_CONTRACT_ID');
    if (contractId && contractId !== 'C...') {
      try {
        const onChainBalanceStr = await this.blockchainService.getBalance(
          user.walletAddress,
        );
        const onChainBalance = parseFloat(onChainBalanceStr);
        const finalBalance = Math.max(0, onChainBalance - totalSpent);
        return { balance: finalBalance.toFixed(2) };
      } catch (error: any) {
        this.logger.error(
          `Error al consultar balance Soroban on-chain: ${error.message}`,
        );
      }
    }

    // 3. Fallback: calculate mock balance dynamically based on DB rewards and redemptions
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
          batchId: { not: null },
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
        totalEarned = redemptions.reduce((sum, r) => sum + r.tokenAmount, 0);
      }
    }

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
      'livora_wallet_aes256_secret!';
    const userSecretKey = CryptoUtil.decrypt(
      user.encryptedPrivateKey,
      encryptionKey,
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

  async getTransactionHistory(userId: string) {
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
          const rate =
            {
              PET: 10,
              CARTON: 5,
              CARTÓN: 5,
              VIDRIO: 3,
              PLASTICO: 10,
              PLÁSTICO: 10,
              ALUMINIO: 15,
              HDPE: 10,
            }[mat.toUpperCase()] || 5;
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
          recipientName: 'Sistema Livora (EcoTokens)',
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
          batchId: { not: null },
        },
        include: {
          batch: {
            include: {
              destinationCenter: {
                select: { email: true, walletAddress: true },
              },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      for (const r of reqs) {
        if (r.batch?.status === 'RECEIVED') {
          const mats =
            (r.batch.materialsActual as Record<string, number>) || {};
          let batchTotal = 0;
          for (const [mat, wt] of Object.entries(mats)) {
            const rate =
              {
                PET: 10,
                CARTON: 5,
                CARTÓN: 5,
                VIDRIO: 3,
                PLASTICO: 10,
                PLÁSTICO: 10,
                ALUMINIO: 15,
                HDPE: 10,
              }[mat.toUpperCase()] || 5;
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
            recipientName: 'Sistema Livora (EcoTokens)',
            recipientWallet:
              r.batch.destinationCenter?.walletAddress ||
              'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
            txHash: r.batch.txHash || null,
            ipfsCid: r.batch.ipfsCid || null,
            createdAt: r.batch.updatedAt,
          });
        }
      }
    }

    // Sort by date descending
    return txs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
}
