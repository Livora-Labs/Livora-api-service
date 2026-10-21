import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User, WalletVault, RedemptionTransaction, WalletTransfer } from '@prisma/client';
import { IWalletsRepository } from './wallets.repository.interface';

/**
 * Implementación Concreta de Repositorio de Billeteras (PUCP Disoft - Data Mapper Pattern)
 * Centraliza las consultas y persistencia de llaves encriptadas y transacciones sobre PostgreSQL.
 */
@Injectable()
export class WalletsRepository implements IWalletsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserById(userId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
    });
  }

  async findCompletedRedemptions(userId: string): Promise<RedemptionTransaction[]> {
    return this.prisma.redemptionTransaction.findMany({
      where: { userId, status: 'COMPLETED' },
    });
  }

  async findWalletVault(userId: string): Promise<WalletVault | null> {
    return this.prisma.walletVault.findUnique({
      where: { userId },
    });
  }

  async upsertWalletVault(
    userId: string,
    encryptedPrivateKey: string,
    encryptionIv?: string,
    encryptionTag?: string,
  ): Promise<WalletVault> {
    return this.prisma.walletVault.upsert({
      where: { userId },
      update: {
        encryptedPrivateKey,
        encryptionIv,
        encryptionTag,
      },
      create: {
        userId,
        encryptedPrivateKey,
        encryptionIv,
        encryptionTag,
      },
    });
  }

  async deleteWalletVault(userId: string): Promise<void> {
    await this.prisma.walletVault.deleteMany({
      where: { userId },
    });
  }

  async createWalletTransfer(data: any): Promise<WalletTransfer> {
    return this.prisma.walletTransfer.create({ data });
  }
}
