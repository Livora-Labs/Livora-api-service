import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { WalletsService } from './wallets.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';
import { CryptoUtil } from '../common/utils/crypto.util';

describe('WalletsService', () => {
  let service: WalletsService;
  let prisma: jest.Mocked<PrismaService>;
  let blockchainService: jest.Mocked<BlockchainService>;
  let configService: jest.Mocked<ConfigService>;

  const encryptionKey = 'livora_wallet_aes256_secret!';
  const userKeypair = Keypair.random();
  const encryptedKey = CryptoUtil.encrypt(userKeypair.secret(), encryptionKey);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
            },
            redemptionTransaction: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            batch: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            collectionRequest: {
              findMany: jest.fn().mockResolvedValue([]),
              count: jest.fn().mockResolvedValue(1),
            },
            storeProfile: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
          },
        },
        {
          provide: BlockchainService,
          useValue: {
            executeSubsidizedTransfer: jest.fn(),
            getBalance: jest.fn(),
            getMaterialRate: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((key: string, defaultVal: any) => {
                if (key === 'WALLET_ENCRYPTION_KEY') return encryptionKey;
                if (key === 'ECOTOKEN_CONTRACT_ID')
                  return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
                return defaultVal;
              }),
          },
        },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
    prisma = module.get(PrismaService);
    blockchainService = module.get(BlockchainService);
    configService = module.get(ConfigService);
  });

  describe('sendTransaction (FeeBump Subsidization)', () => {
    it('should successfully execute subsidized transfer using FeeBumpTransaction via BlockchainService', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'user@livora.earth',
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer.mockResolvedValue({
        hash: 'feebump_real_hash_12345678',
        status: 1,
      });

      const recipientAddress = Keypair.random().publicKey();
      const result = await service.sendTransaction('user-uuid-1', {
        toAddress: recipientAddress,
        amount: 25,
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-uuid-1' },
      });

      expect(blockchainService.executeSubsidizedTransfer).toHaveBeenCalledWith(
        userKeypair.secret(),
        recipientAddress,
        25,
      );

      expect(result).toEqual({
        status: 'PROCESSING',
        transactionId: 'feebump_real_hash_12345678',
        message:
          'Transacción subsidiada por el Relayer y enviada a la red Stellar Testnet',
        fromUser: 'user@livora.earth',
        toAddress: recipientAddress,
        amount: 25,
      });
    });

    it('should throw NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.sendTransaction('non-existent-user', {
          toAddress: Keypair.random().publicKey(),
          amount: 10,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(
        blockchainService.executeSubsidizedTransfer,
      ).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when user has no encrypted private key', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-no-key',
        email: 'nokey@livora.earth',
        encryptedPrivateKey: null,
      } as any);

      await expect(
        service.sendTransaction('user-no-key', {
          toAddress: Keypair.random().publicKey(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(
        blockchainService.executeSubsidizedTransfer,
      ).not.toHaveBeenCalled();
    });

    it('should throw and propagate error when executeSubsidizedTransfer fails without generating mock hashes', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-2',
        email: 'user2@livora.earth',
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer.mockRejectedValue(
        new Error('Circuit Breaker is OPEN: Stellar RPC node unavailable'),
      );

      await expect(
        service.sendTransaction('user-uuid-2', {
          toAddress: Keypair.random().publicKey(),
          amount: 15,
        }),
      ).rejects.toThrow(
        'Circuit Breaker is OPEN: Stellar RPC node unavailable',
      );
    });
  });

  describe('getBalance', () => {
    it('should return on-chain balance when available', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-3',
        walletAddress: userKeypair.publicKey(),
      } as any);

      blockchainService.getBalance.mockResolvedValue('150.50');

      const result = await service.getBalance('user-uuid-3');
      expect(result).toEqual({ balance: '150.50' });
      expect(blockchainService.getBalance).toHaveBeenCalledWith(
        userKeypair.publicKey(),
      );
    });
  });
});
