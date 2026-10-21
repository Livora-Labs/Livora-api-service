import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { BlockchainFacade } from '../blockchain/facades/blockchain.facade';
import { WalletsRepository } from './repositories/wallets.repository';
import { CryptoUtil } from '../common/utils/crypto.util';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { WalletHistoryAggregatorService } from './services/wallet-history.aggregator';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);
  private readonly historyAggregator: WalletHistoryAggregatorService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    @Optional() private readonly walletsRepo?: WalletsRepository,
    @Optional() private readonly blockchainFacade?: BlockchainFacade,
    @Optional() historyAggregator?: WalletHistoryAggregatorService,
  ) {
    this.historyAggregator =
      historyAggregator ?? new WalletHistoryAggregatorService(this.prisma);
  }

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
        select: {
          householdRewardEarned: true,
          actualWeights: true,
          itemsEstimated: true,
          agreedRates: true,
        },
      });
      for (const r of reqs) {
        if (r.householdRewardEarned != null && Number(r.householdRewardEarned) > 0) {
          totalEarned += Number(r.householdRewardEarned);
        } else {
          const actualWeights =
            (r.actualWeights as Record<string, number>) ||
            (r.itemsEstimated as Record<string, number>) ||
            {};
          const agreedRates = (r.agreedRates as Record<string, number>) || {};
          let reqTotal = 0;
          for (const [mat, rawWt] of Object.entries(actualWeights)) {
            const wt = typeof rawWt === 'number' ? rawWt : parseFloat(String(rawWt)) || 0;
            const rate =
              agreedRates[mat] ||
              agreedRates[mat.toUpperCase()] ||
              (await this.blockchainService.getMaterialRate(mat));
            reqTotal += wt * rate;
          }
          totalEarned += reqTotal * 0.25;
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

    // Sumar transferencias recibidas (recompensas de misiones de bosque o transferencias P2P recibidas)
    const receivedTransfers = await this.prisma.walletTransfer.findMany({
      where: { receiverUserId: user.id, status: 'COMPLETED' },
      select: { amount: true },
    });
    const totalTransfersReceived = receivedTransfers.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );
    totalEarned += totalTransfersReceived;

    // Restar transferencias P2P enviadas a otros usuarios (excluyendo abonos internos donde sender == receiver)
    const sentP2PTransfers = await this.prisma.walletTransfer.findMany({
      where: {
        senderUserId: user.id,
        receiverUserId: { not: user.id },
        status: 'COMPLETED',
      },
      select: { amount: true },
    });
    const totalTransfersSent = sentP2PTransfers.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );

    const payments = await this.prisma.paymentTransaction.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { tokenAmount: true },
    });
    const totalPayments = payments.reduce((sum, p) => sum + Number(p.tokenAmount), 0);
    totalEarned += totalPayments;

    const finalBalance = Math.max(0, totalEarned - totalSpent - totalTransfersSent);
    return { balance: finalBalance.toFixed(2) };
  }

  /**
   * Helper de custodia: Obtiene y descifra la clave privada de un usuario desde WalletVault.
   */
  async getDecryptedPrivateKey(userId: string): Promise<string | null> {
    const vault = await this.prisma.walletVault.findUnique({
      where: { userId },
    });

    const encryptedKey = vault?.encryptedPrivateKey;
    if (!encryptedKey) {
      return null;
    }

    const encryptionKey =
      this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
      this.configService.get<string>('ENCRYPTION_KEY');
    if (!encryptionKey && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'CRITICAL SECURITY ERROR: La variable WALLET_ENCRYPTION_KEY es obligatoria para descifrar claves de custodia Web3.',
      );
    }
    const finalKey = encryptionKey || 'test_isolated_wallet_encryption_key_32c';
    return CryptoUtil.decrypt(encryptedKey, finalKey);
  }

  async storeWalletVault(
    userId: string,
    encryptedPrivateKey: string,
    options?: { encryptionIv?: string; encryptionTag?: string; isSponsored?: boolean },
  ): Promise<void> {
    await this.prisma.walletVault.upsert({
      where: { userId },
      update: {
        encryptedPrivateKey,
        encryptionIv: options?.encryptionIv,
        encryptionTag: options?.encryptionTag,
        isSponsored: options?.isSponsored ?? false,
      },
      create: {
        userId,
        encryptedPrivateKey,
        encryptionIv: options?.encryptionIv,
        encryptionTag: options?.encryptionTag,
        isSponsored: options?.isSponsored ?? false,
      },
    });
  }

  async deleteWalletVault(userId: string): Promise<void> {
    await this.prisma.walletVault.deleteMany({
      where: { userId },
    });
  }

  /**
   * Envía una transacción de transferencia entre billeteras utilizando la arquitectura
   * gasless fee-bump / delegated signing:
   * firmada por el usuario en la transacción interna y subsidiada por la wallet relayer en la externa.
   */
  async sendTransaction(userId: string, dto: CreateTransactionDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const userSecretKey = await this.getDecryptedPrivateKey(userId);
    if (!userSecretKey) {
      throw new BadRequestException(
        'El usuario no posee una clave privada válida o registrada para firmar la transacción',
      );
    }

    const receipt = await this.blockchainService.executeSubsidizedTransfer(
      userSecretKey,
      dto.toAddress,
      dto.amount,
    );

    // Persistir la transferencia P2P en la BD para el historial de ambas partes
    const receiverUser = await this.prisma.user.findFirst({
      where: { walletAddress: dto.toAddress },
    });

    await this.prisma.walletTransfer.create({
      data: {
        senderUserId: userId,
        receiverUserId: receiverUser?.id ?? null,
        fromAddress: user.walletAddress!,
        toAddress: dto.toAddress,
        amount: dto.amount,
        txHash: receipt.hash,
        status: 'COMPLETED',
      },
    });

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

  /**
   * Consulta el historial poli-fuente de transacciones delegando en el agregador especializado
   * (PUCP Disoft - Aggregator Pattern)
   */
  async getTransactionHistory(
    userId: string,
    page = 1,
    limit = 15,
    direction?: string,
  ) {
    return this.historyAggregator.getTransactionHistory(
      userId,
      page,
      limit,
      direction,
    );
  }
}
