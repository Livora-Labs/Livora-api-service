import { User, WalletVault, RedemptionTransaction, WalletTransfer } from '@prisma/client';

/**
 * Patrón Repositorio / Data Mapper de Billeteras (PUCP Disoft Diapositiva 08 y 09)
 * Aísla la capa de servicios de billeteras y custodias de las llamadas a Prisma ORM.
 */
export interface IWalletsRepository {
  findUserById(userId: string): Promise<User | null>;
  findCompletedRedemptions(userId: string): Promise<RedemptionTransaction[]>;
  findWalletVault(userId: string): Promise<WalletVault | null>;
  upsertWalletVault(
    userId: string,
    encryptedPrivateKey: string,
    encryptionIv?: string,
    encryptionTag?: string,
  ): Promise<WalletVault>;
  deleteWalletVault(userId: string): Promise<void>;
  createWalletTransfer(data: any): Promise<WalletTransfer>;
}
