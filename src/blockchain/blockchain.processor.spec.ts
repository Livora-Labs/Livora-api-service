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
  let prisma: any;
  let websocketsService: any;
  let ipfsService: any;
  let blockchainService: any;
  let notificationsService: any;
  let configService: any;

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
            sendPushNotification: jest
              .fn()
              .mockResolvedValue({ success: true }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'WALLET_ENCRYPTION_KEY')
                return 'livora_wallet_aes256_secret!';
              if (key === 'ECOTOKEN_CONTRACT_ID')
                return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
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
      const encryptedKey = CryptoUtil.encrypt(
        secret,
        'livora_wallet_aes256_secret!',
      );

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain.mockResolvedValue(5n);
      blockchainService.executeDelegatedTransfer.mockResolvedValue({
        hash: 'stellar_tx_hash_123',
      } as any);

      const result = await processor.process(job);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: jobData.fromUserId },
        select: { encryptedPrivateKey: true },
      });

      expect(blockchainService.getNonceOnChain).toHaveBeenCalledWith(
        jobData.fromWallet,
      );

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
        explorerUrl:
          'https://stellar.expert/explorer/testnet/tx/stellar_tx_hash_123',
      });
    });

    it('should propagate error and reject without saving mock txHash if executeDelegatedTransfer throws', async () => {
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
      const encryptedKey = CryptoUtil.encrypt(
        secret,
        'livora_wallet_aes256_secret!',
      );

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain.mockResolvedValue(1n);
      blockchainService.executeDelegatedTransfer.mockRejectedValue(
        new Error('Transaction failed'),
      );

      await expect(processor.process(job)).rejects.toThrow(
        'Transaction failed',
      );

      expect(blockchainService.executeDelegatedTransfer).toHaveBeenCalled();
      expect(prisma.redemptionTransaction.update).not.toHaveBeenCalled();
    });

    it('should throw error if user has no encrypted private key', async () => {
      const jobData = {
        redemptionId: 'redemption-789',
        fromUserId: 'user-no-key',
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

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: null,
      } as any);

      await expect(processor.process(job)).rejects.toThrow(
        'El usuario user-no-key no posee una clave privada registrada',
      );
      expect(blockchainService.executeDelegatedTransfer).not.toHaveBeenCalled();
      expect(prisma.redemptionTransaction.update).not.toHaveBeenCalled();
    });
  });

  describe('processBatchBlockchain', () => {
    it('should process batch and update DB when on-chain call succeeds', async () => {
      const jobData = {
        batchId: 'batch-001',
        collectorId: 'collector-1',
        centerId: 'center-1',
        materialsActual: { PET: 10, CARTON: 5 },
        householdIds: ['hh-1'],
      };

      const job = {
        name: 'process-batch-blockchain',
        data: jobData,
        id: 'batch-job-1',
      } as unknown as Job<any>;

      ipfsService.uploadBatchMetadata = jest
        .fn()
        .mockResolvedValue('QmTestCid123');
      ipfsService.getGatewayUrl = jest
        .fn()
        .mockReturnValue('https://ipfs.io/ipfs/QmTestCid123');

      blockchainService.getWorkerAddress = jest
        .fn()
        .mockReturnValue(Keypair.random().publicKey());
      blockchainService.registerBatchWeighed = jest.fn().mockResolvedValue({
        hash: 'batch_tx_hash_abc',
      });

      prisma.user.findUnique = jest.fn().mockResolvedValue({
        walletAddress: Keypair.random().publicKey(),
      } as any);
      prisma.user.findMany = jest
        .fn()
        .mockResolvedValue([
          { id: 'hh-1', walletAddress: Keypair.random().publicKey() },
        ] as any);
      prisma.$transaction = jest.fn().mockImplementation(async (callback) =>
        callback({
          batch: { update: jest.fn() },
          inventoryItem: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
          },
          inventoryMovement: { create: jest.fn() },
        }),
      );
      websocketsService.emitBatchCompleted = jest.fn();

      const result = await processor.process(job);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('batch_tx_hash_abc');
      expect(blockchainService.registerBatchWeighed).toHaveBeenCalled();
    });

    it('should throw error without mock fallback if registerBatchWeighed fails', async () => {
      const jobData = {
        batchId: 'batch-002',
        collectorId: 'collector-1',
        centerId: 'center-1',
        materialsActual: { PET: 10 },
        householdIds: [],
      };

      const job = {
        name: 'process-batch-blockchain',
        data: jobData,
        id: 'batch-job-2',
      } as unknown as Job<any>;

      ipfsService.uploadBatchMetadata = jest
        .fn()
        .mockResolvedValue('QmTestCid456');
      blockchainService.getWorkerAddress = jest
        .fn()
        .mockReturnValue(Keypair.random().publicKey());
      blockchainService.registerBatchWeighed = jest
        .fn()
        .mockRejectedValue(new Error('RPC node connection failed'));

      prisma.user.findUnique = jest.fn().mockResolvedValue({
        walletAddress: Keypair.random().publicKey(),
      } as any);

      await expect(processor.process(job)).rejects.toThrow(
        'RPC node connection failed',
      );
    });
  });

  describe('processSettlementTransfer', () => {
    it('should process settlement using subsidized transfer when user has private key', async () => {
      const jobData = {
        settlementId: 'settle-001',
        fromStoreUserId: 'store-user-1',
        fromWallet,
        toWallet,
        tokenAmount: 50,
      };

      const job = {
        name: 'settlement-transfer',
        data: jobData,
        id: 'settle-job-1',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(
        secret,
        'livora_wallet_aes256_secret!',
      );

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer = jest
        .fn()
        .mockResolvedValue({
          hash: 'settle_tx_hash_999',
        });

      const result = await processor.process(job);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('settle_tx_hash_999');
      expect(blockchainService.executeSubsidizedTransfer).toHaveBeenCalledWith(
        secret,
        toWallet,
        50,
      );
    });

    it('should throw error when settlement transfer fails', async () => {
      const jobData = {
        settlementId: 'settle-002',
        fromStoreUserId: 'store-user-2',
        fromWallet,
        toWallet,
        tokenAmount: 20,
      };

      const job = {
        name: 'settlement-transfer',
        data: jobData,
        id: 'settle-job-2',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(
        secret,
        'livora_wallet_aes256_secret!',
      );

      prisma.user.findUnique.mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer = jest
        .fn()
        .mockRejectedValue(new Error('Subsidized settlement failed'));

      await expect(processor.process(job)).rejects.toThrow(
        'Subsidized settlement failed',
      );
    });
  });

  describe('Worker events', () => {
    it('should log worker lifecycle events without throwing', () => {
      const job = {
        id: 'job-evt-1',
        name: 'test-job',
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as any;
      expect(() => processor.onCompleted(job)).not.toThrow();
      expect(() =>
        processor.onFailed(job, new Error('Test fail')),
      ).not.toThrow();
      expect(() => processor.onError(new Error('Worker error'))).not.toThrow();
    });
  });
});
