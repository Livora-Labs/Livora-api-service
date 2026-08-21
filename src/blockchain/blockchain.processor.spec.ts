import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { Keypair } from '@stellar/stellar-sdk';
import { BlockchainProcessor } from './blockchain.processor';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { IpfsService } from './services/ipfs.service';
import { BlockchainService } from './services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { CryptoUtil } from '../common/utils/crypto.util';

describe('BlockchainProcessor', () => {
  let processor: BlockchainProcessor;
  let prisma: jest.Mocked<PrismaService>;
  let websocketsService: jest.Mocked<WebsocketsService>;
  let ipfsService: jest.Mocked<IpfsService>;
  let blockchainService: jest.Mocked<BlockchainService>;
  let notificationsService: jest.Mocked<NotificationsService>;
  let configService: jest.Mocked<ConfigService>;

  const fromWallet = Keypair.random().publicKey();
  const toWallet = Keypair.random().publicKey();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainProcessor,
        {
          provide: PrismaService,
          useValue: {
            redemptionTransaction: {
              update: jest.fn(),
            },
            user: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: WebsocketsService,
          useValue: {
            emitUserEvent: jest.fn(),
          },
        },
        {
          provide: IpfsService,
          useValue: {},
        },
        {
          provide: BlockchainService,
          useValue: {
            executeDelegatedTransfer: jest.fn(),
            getNonceOnChain: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendPushNotification: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'WALLET_ENCRYPTION_KEY') return 'livora_wallet_aes256_secret!';
              if (key === 'ECOTOKEN_CONTRACT_ID') return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
              return null;
            }),
          },
        },
      ],
    }).compile();

    processor = module.get<BlockchainProcessor>(BlockchainProcessor);
    prisma = module.get(PrismaService);
    websocketsService = module.get(WebsocketsService);
    ipfsService = module.get(IpfsService);
    blockchainService = module.get(BlockchainService);
    notificationsService = module.get(NotificationsService);
    configService = module.get(ConfigService);
  });

  describe('processRedemptionTransfer', () => {
    it('should call executeDelegatedTransfer with correct parameters from job data', async () => {
      const jobData = {
        redemptionId: 'redemption-123',
        fromUserId: 'user-1',
        toStoreUserId: 'store-1',
        fromWallet,
        toWallet,
        tokenAmount: '10',
      };

      const job = {
        name: 'redemption-transfer',
        data: jobData,
        id: 'job-1',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(secret, 'livora_wallet_aes256_secret!');

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain.mockResolvedValue(5n);
      blockchainService.executeDelegatedTransfer.mockResolvedValue({ hash: 'stellar_tx_hash_123' } as any);

      const result = await processor.process(job);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: jobData.fromUserId },
        select: { encryptedPrivateKey: true },
      });

      expect(blockchainService.getNonceOnChain).toHaveBeenCalledWith(jobData.fromWallet);

      expect(blockchainService.executeDelegatedTransfer).toHaveBeenCalledWith(
        jobData.fromWallet,
        jobData.toWallet,
        '10',
        5,
        expect.any(Buffer),
        expect.any(Buffer),
      );

      expect(prisma.redemptionTransaction.update).toHaveBeenCalledWith({
        where: { id: jobData.redemptionId },
        data: { txHash: 'stellar_tx_hash_123' },
      });

      expect(websocketsService.emitUserEvent).toHaveBeenCalledWith(
        jobData.fromUserId,
        'redemption:completed_onchain',
        {
          redemptionId: jobData.redemptionId,
          txHash: 'stellar_tx_hash_123',
          tokenAmount: jobData.tokenAmount,
        },
      );

      expect(result).toEqual({
        success: true,
        redemptionId: jobData.redemptionId,
        txHash: 'stellar_tx_hash_123',
        explorerUrl: 'https://stellar.expert/explorer/testnet/tx/stellar_tx_hash_123',
      });
    });

    it('should fallback to mock txHash if executeDelegatedTransfer throws', async () => {
      const jobData = {
        redemptionId: 'redemption-456',
        fromUserId: 'user-2',
        toStoreUserId: 'store-2',
        fromWallet,
        toWallet,
        tokenAmount: '5',
      };

      const job = {
        name: 'redemption-transfer',
        data: jobData,
        id: 'job-2',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(secret, 'livora_wallet_aes256_secret!');

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain.mockResolvedValue(1n);
      blockchainService.executeDelegatedTransfer.mockRejectedValue(new Error('Transaction failed'));

      const result = await processor.process(job);

      expect(blockchainService.executeDelegatedTransfer).toHaveBeenCalled();
      
      expect(prisma.redemptionTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobData.redemptionId },
          data: {
            txHash: expect.stringMatching(/^mockredempt[0-9a-f]+$/),
          },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.txHash).toMatch(/^mockredempt[0-9a-f]+$/);
    });

    it('should handle missing nonce gracefully (default to 0n)', async () => {
      const jobData = {
        redemptionId: 'redemption-789',
        fromUserId: 'user-3',
        toStoreUserId: 'store-3',
        fromWallet,
        toWallet,
        tokenAmount: '2',
      };

      const job = {
        name: 'redemption-transfer',
        data: jobData,
        id: 'job-3',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(secret, 'livora_wallet_aes256_secret!');

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain.mockRejectedValue(new Error('Network error'));
      blockchainService.executeDelegatedTransfer.mockResolvedValue({ hash: 'stellar_tx_hash_789' } as any);

      await processor.process(job);

      expect(blockchainService.executeDelegatedTransfer).toHaveBeenCalledWith(
        jobData.fromWallet,
        jobData.toWallet,
        '2',
        0,
        expect.any(Buffer),
        expect.any(Buffer),
      );
    });
  });
});
