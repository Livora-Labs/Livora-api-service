import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  rpc as StellarRpc,
  TransactionBuilder,
  FeeBumpTransaction,
  Account,
  Operation,
  Address,
} from '@stellar/stellar-sdk';
import CircuitBreaker from 'opossum';
import { Job } from 'bullmq';
import {
  BlockchainService,
  STELLAR_CIRCUIT_BREAKER_OPTIONS,
} from './services/blockchain.service';
import { BlockchainProcessor } from './blockchain.processor';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { IpfsService } from './services/ipfs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CryptoUtil } from '../common/utils/crypto.util';
import { WalletsService } from '../wallets/wallets.service';

describe('Milestone M2 Adversarial Test Suite: Web3 Blockchain Resiliency & Circuit Breaker', () => {
  const workerKeypair = Keypair.random();
  const encryptionKey = 'livora_wallet_aes256_secret!';
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const networkPassphrase = 'Test SDF Network ; September 2015';

  describe('1. Opossum Circuit Breaker Adversarial & Stress Testing', () => {
    let service: BlockchainService;
    let configService: ConfigService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BlockchainService,
          {
            provide: ConfigService,
            useValue: {
              get: jest
                .fn()
                .mockImplementation((key: string, defaultVal: any) => {
                  if (key === 'STELLAR_RPC_URL')
                    return 'https://soroban-testnet.stellar.org';
                  if (key === 'STELLAR_NETWORK_PASSPHRASE')
                    return networkPassphrase;
                  if (key === 'WORKER_SECRET_KEY')
                    return workerKeypair.secret();
                  if (key === 'ECOTOKEN_CONTRACT_ID') return contractId;
                  if (key === 'STELLAR_CB_TIMEOUT') return 200; // Fast timeout for tests
                  if (key === 'STELLAR_CB_ERROR_THRESHOLD') return 50;
                  if (key === 'STELLAR_CB_RESET_TIMEOUT') return 300;
                  if (key === 'STELLAR_CB_VOLUME_THRESHOLD') return 3;
                  return defaultVal;
                }),
            },
          },
        ],
      }).compile();

      service = module.get<BlockchainService>(BlockchainService);
      configService = module.get(ConfigService);
      service.onModuleInit();
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await service.onModuleDestroy();
    });

    it('should NOT trip when failures are below volumeThreshold (e.g. 2 failures out of 2 calls)', async () => {
      const breaker = service.getCircuitBreaker();
      const failAction = jest
        .fn()
        .mockRejectedValue(new Error('RPC node connection refused'));

      // Call 1: failure
      await expect(service.executeRpc(failAction)).rejects.toThrow(
        'RPC node connection refused',
      );
      expect(breaker.opened).toBe(false);

      // Call 2: failure
      await expect(service.executeRpc(failAction)).rejects.toThrow(
        'RPC node connection refused',
      );
      expect(breaker.opened).toBe(false);

      // Total 2 requests < volumeThreshold (3), so breaker remains closed
      expect(breaker.stats.failures).toBe(2);
      expect(breaker.stats.fires).toBe(2);
      expect(breaker.opened).toBe(false);
    });

    it('should trip to OPEN exactly upon meeting volumeThreshold (3) with >= 50% failure rate', async () => {
      const breaker = service.getCircuitBreaker();
      const failAction = jest
        .fn()
        .mockRejectedValue(new Error('RPC 503 Service Unavailable'));

      // 3 consecutive failures: 3/3 = 100% >= 50% threshold, meets volumeThreshold 3
      for (let i = 0; i < 3; i++) {
        await expect(service.executeRpc(failAction)).rejects.toThrow(
          'RPC 503 Service Unavailable',
        );
      }

      expect(breaker.opened).toBe(true);

      // Verify immediate fast-fail on subsequent attempt: action is NEVER called
      const neverCalledAction = jest.fn().mockResolvedValue('data');
      await expect(service.executeRpc(neverCalledAction)).rejects.toThrow();
      expect(neverCalledAction).not.toHaveBeenCalled();
    });

    it('should timeout and record failure when RPC hangs beyond configured timeout', async () => {
      const breaker = service.getCircuitBreaker();

      // Hanging action that exceeds 200ms timeout
      const hangingAction = () =>
        new Promise((resolve) => setTimeout(() => resolve('late_data'), 500));

      await expect(service.executeRpc(hangingAction)).rejects.toThrow(
        /Timed out/,
      );
      expect(breaker.stats.timeouts).toBeGreaterThanOrEqual(1);
    });

    it('should recover: transition to HALF_OPEN after resetTimeout, and CLOSE on successful probe', async () => {
      const breaker = service.getCircuitBreaker();
      const failAction = jest
        .fn()
        .mockRejectedValue(new Error('RPC Server Down'));

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(service.executeRpc(failAction)).rejects.toThrow(
          'RPC Server Down',
        );
      }
      expect(breaker.opened).toBe(true);

      // Wait for resetTimeout (300ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(breaker.halfOpen).toBe(true);

      // Probe call succeeds
      const recoveryAction = jest.fn().mockResolvedValue('rpc_recovered');
      const result = await service.executeRpc(recoveryAction);

      expect(result).toBe('rpc_recovered');
      expect(breaker.opened).toBe(false);
      expect(breaker.halfOpen).toBe(false);
      expect(breaker.closed).toBe(true);
    });

    it('should immediately re-OPEN if probe call fails in HALF_OPEN state', async () => {
      const breaker = service.getCircuitBreaker();
      const failAction = jest
        .fn()
        .mockRejectedValue(new Error('RPC Server Down'));

      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        await expect(service.executeRpc(failAction)).rejects.toThrow(
          'RPC Server Down',
        );
      }
      expect(breaker.opened).toBe(true);

      // Wait for resetTimeout (300ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(breaker.halfOpen).toBe(true);

      // Probe fails
      await expect(service.executeRpc(failAction)).rejects.toThrow(
        'RPC Server Down',
      );

      // Should immediately revert to OPEN
      expect(breaker.opened).toBe(true);
      expect(breaker.halfOpen).toBe(false);
    });

    it('should wrap all critical RPC methods with circuit breaker', async () => {
      const mockRpc = (service as any).rpcServer;
      mockRpc.getAccount = jest
        .fn()
        .mockRejectedValue(new Error('Simulated RPC getAccount error'));
      mockRpc.simulateTransaction = jest
        .fn()
        .mockRejectedValue(new Error('Simulated RPC simulate error'));
      mockRpc.sendTransaction = jest
        .fn()
        .mockRejectedValue(new Error('Simulated RPC send error'));
      mockRpc.getTransaction = jest
        .fn()
        .mockRejectedValue(new Error('Simulated RPC getTx error'));
      mockRpc.getHealth = jest
        .fn()
        .mockRejectedValue(new Error('Simulated RPC health error'));

      const testUser = Keypair.random().publicKey();

      await expect(service.getNonceOnChain(testUser)).rejects.toThrow(
        'Simulated RPC getAccount error',
      );
      await expect(service.getBalance(testUser)).rejects.toThrow(
        'Simulated RPC getAccount error',
      );
      expect(await service.checkConnection()).toBe(false);
    });
  });

  describe('2. Stellar FeeBumpTransaction Mechanics & Signer Separation', () => {
    let service: BlockchainService;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BlockchainService,
          {
            provide: ConfigService,
            useValue: {
              get: jest
                .fn()
                .mockImplementation((key: string, defaultVal: any) => {
                  if (key === 'STELLAR_RPC_URL')
                    return 'https://soroban-testnet.stellar.org';
                  if (key === 'STELLAR_NETWORK_PASSPHRASE')
                    return networkPassphrase;
                  if (key === 'WORKER_SECRET_KEY')
                    return workerKeypair.secret();
                  if (key === 'ECOTOKEN_CONTRACT_ID') return contractId;
                  return defaultVal;
                }),
            },
          },
        ],
      }).compile();

      service = module.get<BlockchainService>(BlockchainService);
      service.onModuleInit();
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('should correctly structure FeeBumpTransaction with user innerTx and worker feeSource', async () => {
      const userKeypair = Keypair.random();
      const recipientKeypair = Keypair.random();
      const mockRpc = (service as any).rpcServer;

      mockRpc.getAccount = jest.fn().mockResolvedValue({
        sequenceNumber: () => '555',
      });

      mockRpc.simulateTransaction = jest.fn().mockResolvedValue({
        transactionData: 'mock_soroban_footprint',
        minResourceFee: '100',
      });

      jest.spyOn(StellarRpc.Api, 'isSimulationSuccess').mockReturnValue(true);

      jest.spyOn(StellarRpc, 'assembleTransaction').mockImplementation(
        (rawTx: any) =>
          ({
            build: () => {
              const tx = rawTx;
              tx.sign = jest.fn();
              return tx;
            },
          }) as any,
      );

      let capturedFeeBumpTx: FeeBumpTransaction | null = null;

      mockRpc.sendTransaction = jest
        .fn()
        .mockImplementation((tx: FeeBumpTransaction) => {
          capturedFeeBumpTx = tx;
          return Promise.resolve({
            status: 'SUCCESS',
            hash: 'tx_feebump_hash_verified_999',
          });
        });

      mockRpc.getTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        ledger: 54321,
      });

      const result = await service.executeSubsidizedTransfer(
        userKeypair.secret(),
        recipientKeypair.publicKey(),
        100,
      );

      expect(result.hash).toBe('tx_feebump_hash_verified_999');
      expect(result.status).toBe(1);

      // Verify FeeBump Transaction Properties
      expect(capturedFeeBumpTx).toBeDefined();
      expect(capturedFeeBumpTx).toBeInstanceOf(FeeBumpTransaction);

      const feeBump = capturedFeeBumpTx as unknown as FeeBumpTransaction;
      // 1. Outer feeSource must be the Relayer worker public key
      expect(feeBump.feeSource).toBe(workerKeypair.publicKey());
      // 2. Max fee allocated by relayer (CAP-0015: baseFee * (num_ops + 1) = 10000 * 2 = 20000)
      expect(feeBump.fee).toBe('20000');
      // 3. Inner transaction source must be the user's public key
      expect(feeBump.innerTransaction.source).toBe(userKeypair.publicKey());
      // 4. Inner transaction sequence number is incremented from user account sequence (555 -> 556)
      expect(feeBump.innerTransaction.sequence).toBe('556');
      // 5. Outer transaction has Relayer signature
      expect(feeBump.signatures.length).toBeGreaterThanOrEqual(1);
    });

    it('should fail if user secret key is invalid ed25519 seed', async () => {
      await expect(
        service.executeSubsidizedTransfer(
          'INVALID_SECRET_KEY_NOT_STELLAR',
          Keypair.random().publicKey(),
          10,
        ),
      ).rejects.toThrow();
    });

    it('should throw simulation errors with detailed cause when Soroban fails', async () => {
      const userKeypair = Keypair.random();
      const mockRpc = (service as any).rpcServer;

      mockRpc.getAccount = jest.fn().mockResolvedValue({
        sequenceNumber: () => '100',
      });

      mockRpc.simulateTransaction = jest.fn().mockResolvedValue({
        error: 'HostError: Error(Contract, #1)',
      });

      jest.spyOn(StellarRpc.Api, 'isSimulationSuccess').mockReturnValue(false);

      await expect(
        service.executeSubsidizedTransfer(
          userKeypair.secret(),
          Keypair.random().publicKey(),
          10,
        ),
      ).rejects.toThrow(/Simulation failed.*HostError/);
    });
  });

  describe('3. BullMQ Processor Error Propagation & Database Integrity', () => {
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
              batch: {
                update: jest.fn(),
              },
              redemptionTransaction: {
                update: jest.fn(),
              },
              user: {
                findUnique: jest.fn(),
                findMany: jest.fn(),
              },
              inventoryItem: {
                findFirst: jest.fn(),
                update: jest.fn(),
                create: jest.fn(),
              },
              inventoryMovement: {
                create: jest.fn(),
              },
              $transaction: jest.fn(),
            },
          },
          {
            provide: WebsocketsService,
            useValue: {
              emitBatchCompleted: jest.fn(),
              emitUserEvent: jest.fn(),
            },
          },
          {
            provide: IpfsService,
            useValue: {
              uploadBatchMetadata: jest.fn(),
              getGatewayUrl: jest.fn((cid) => `https://ipfs.io/ipfs/${cid}`),
            },
          },
          {
            provide: BlockchainService,
            useValue: {
              getWorkerAddress: jest
                .fn()
                .mockReturnValue(workerKeypair.publicKey()),
              registerBatchWeighed: jest.fn(),
              executeDelegatedTransfer: jest.fn(),
              executeSubsidizedTransfer: jest.fn(),
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
                if (key === 'WALLET_ENCRYPTION_KEY') return encryptionKey;
                if (key === 'ECOTOKEN_CONTRACT_ID') return contractId;
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

    it('Adversarial: processBatchBlockchain throws and does NOT pollute DB with fake txHash when blockchain call fails', async () => {
      const jobData = {
        batchId: 'batch-failing-uuid',
        collectorId: 'collector-uuid-1',
        centerId: 'center-uuid-1',
        materialsActual: { PET: 25.5, CARTON: 10 },
        householdIds: ['household-1', 'household-2'],
      };

      const job = {
        name: 'process-batch-blockchain',
        data: jobData,
        id: 'job-batch-fail',
      } as unknown as Job<any>;

      ipfsService.uploadBatchMetadata = jest
        .fn()
        .mockResolvedValue('QmValidCidForTest');
      prisma.user.findUnique = jest.fn().mockResolvedValue({
        walletAddress: Keypair.random().publicKey(),
      } as any);
      prisma.user.findMany = jest.fn().mockResolvedValue([
        { id: 'household-1', walletAddress: Keypair.random().publicKey() },
        { id: 'household-2', walletAddress: Keypair.random().publicKey() },
      ] as any);

      // Simulate blockchain failure (e.g. circuit open or out of gas)
      blockchainService.registerBatchWeighed = jest
        .fn()
        .mockRejectedValue(
          new Error('CircuitBreaker: OPEN. Stellar RPC is unreachable.'),
        );

      // Must reject and re-throw
      await expect(processor.process(job)).rejects.toThrow(
        'CircuitBreaker: OPEN. Stellar RPC is unreachable.',
      );

      // Must NOT update PostgreSQL batch
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.batch.update).not.toHaveBeenCalled();
      // Must NOT emit completion websocket
      expect(websocketsService.emitBatchCompleted).not.toHaveBeenCalled();
    });

    it('Adversarial: processRedemptionTransfer throws and does NOT save fake mockredempt hash to PostgreSQL', async () => {
      const jobData = {
        redemptionId: 'redemption-failing-uuid',
        fromUserId: 'user-uuid-1',
        toStoreUserId: 'store-user-uuid-1',
        fromWallet,
        toWallet,
        tokenAmount: 15,
      };

      const job = {
        name: 'redemption-transfer',
        data: jobData,
        id: 'job-redemption-fail',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(secret, encryptionKey);

      prisma.user.findUnique = jest.fn().mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.getNonceOnChain = jest.fn().mockResolvedValue(10n);

      // Blockchain RPC fails
      blockchainService.executeDelegatedTransfer = jest
        .fn()
        .mockRejectedValue(new Error('RPC Error: tx_bad_auth'));

      await expect(processor.process(job)).rejects.toThrow(
        'RPC Error: tx_bad_auth',
      );

      // Critical check: No fake hash updated in database
      expect(prisma.redemptionTransaction.update).not.toHaveBeenCalled();
      expect(websocketsService.emitUserEvent).not.toHaveBeenCalled();
    });

    it('Adversarial: processSettlementTransfer throws and does NOT generate synthetic settle hash', async () => {
      const jobData = {
        settlementId: 'settlement-failing-uuid',
        fromStoreUserId: 'store-user-uuid-2',
        fromWallet,
        toWallet,
        tokenAmount: 100,
      };

      const job = {
        name: 'settlement-transfer',
        data: jobData,
        id: 'job-settlement-fail',
      } as unknown as Job<any>;

      const secret = Keypair.random().secret();
      const encryptedKey = CryptoUtil.encrypt(secret, encryptionKey);

      prisma.user.findUnique = jest.fn().mockResolvedValue({
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer = jest
        .fn()
        .mockRejectedValue(new Error('Settlement Soroban contract error'));

      await expect(processor.process(job)).rejects.toThrow(
        'Settlement Soroban contract error',
      );
    });

    it('Adversarial: corrupted or invalid private key throws immediately without on-chain execution', async () => {
      const jobData = {
        redemptionId: 'redemption-corrupted-key',
        fromUserId: 'user-corrupted',
        toStoreUserId: 'store-user',
        fromWallet,
        toWallet,
        tokenAmount: 10,
      };

      const job = {
        name: 'redemption-transfer',
        data: jobData,
        id: 'job-corrupted-key',
      } as unknown as Job<any>;

      // Malformed ciphertext
      prisma.user.findUnique = jest.fn().mockResolvedValue({
        encryptedPrivateKey: 'invalid_iv:invalid_ciphertext',
      } as any);

      await expect(processor.process(job)).rejects.toThrow(
        /Invalid encrypted text format|No se pudo descifrar la clave privada/,
      );

      expect(blockchainService.executeDelegatedTransfer).not.toHaveBeenCalled();
      expect(prisma.redemptionTransaction.update).not.toHaveBeenCalled();
    });
  });

  describe('4. WalletsService Subsidized FeeBump Delegation', () => {
    let walletsService: WalletsService;
    let prisma: jest.Mocked<PrismaService>;
    let blockchainService: jest.Mocked<BlockchainService>;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WalletsService,
          {
            provide: PrismaService,
            useValue: {
              user: { findUnique: jest.fn() },
              redemptionTransaction: {
                findMany: jest.fn().mockResolvedValue([]),
              },
              batch: { findMany: jest.fn().mockResolvedValue([]) },
              collectionRequest: {
                findMany: jest.fn().mockResolvedValue([]),
                count: jest.fn().mockResolvedValue(1),
              },
              storeProfile: { findFirst: jest.fn().mockResolvedValue(null) },
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
              get: jest.fn().mockImplementation((key: string) => {
                if (key === 'WALLET_ENCRYPTION_KEY') return encryptionKey;
                if (key === 'ECOTOKEN_CONTRACT_ID') return contractId;
                return null;
              }),
            },
          },
        ],
      }).compile();

      walletsService = module.get<WalletsService>(WalletsService);
      prisma = module.get(PrismaService);
      blockchainService = module.get(BlockchainService);
    });

    it('Adversarial: sendTransaction propagates on-chain failure without returning fake relayer tx hash', async () => {
      const userKeypair = Keypair.random();
      const encryptedKey = CryptoUtil.encrypt(
        userKeypair.secret(),
        encryptionKey,
      );

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-subsidized-fail',
        email: 'victim@livora.earth',
        encryptedPrivateKey: encryptedKey,
      } as any);

      blockchainService.executeSubsidizedTransfer.mockRejectedValue(
        new Error('Transaction simulation failed: insufficient balance'),
      );

      await expect(
        walletsService.sendTransaction('user-subsidized-fail', {
          toAddress: Keypair.random().publicKey(),
          amount: 50,
        }),
      ).rejects.toThrow('Transaction simulation failed: insufficient balance');
    });
  });
});
