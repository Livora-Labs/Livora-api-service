import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Keypair, rpc as StellarRpc } from '@stellar/stellar-sdk';
import {
  BlockchainService,
  STELLAR_CIRCUIT_BREAKER_OPTIONS,
} from './blockchain.service';

describe('BlockchainService', () => {
  let service: BlockchainService;
  let configService: jest.Mocked<ConfigService>;
  const workerSecret = Keypair.random().secret();

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
                  return 'Test SDF Network ; September 2015';
                if (key === 'WORKER_SECRET_KEY') return workerSecret;
                if (key === 'ECOTOKEN_CONTRACT_ID')
                  return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
                if (key === 'REDIS_HOST') return 'localhost';
                if (key === 'REDIS_PORT') return 6379;
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

  describe('Circuit Breaker Configuration and Lifecycle', () => {
    it('should initialize Circuit Breaker with correct resilience parameters', () => {
      const breaker = service.getCircuitBreaker();
      expect(breaker).toBeDefined();
      expect((breaker as any).options.timeout).toBe(
        STELLAR_CIRCUIT_BREAKER_OPTIONS.timeout,
      );
      expect((breaker as any).options.errorThresholdPercentage).toBe(
        STELLAR_CIRCUIT_BREAKER_OPTIONS.errorThresholdPercentage,
      );
      expect((breaker as any).options.resetTimeout).toBe(
        STELLAR_CIRCUIT_BREAKER_OPTIONS.resetTimeout,
      );
      expect((breaker as any).options.volumeThreshold).toBe(
        STELLAR_CIRCUIT_BREAKER_OPTIONS.volumeThreshold,
      );
      expect(breaker.opened).toBe(false);
    });

    it('should execute actions through Circuit Breaker successfully when closed', async () => {
      const result = await service.executeRpc(async () => 'rpc_success_data');
      expect(result).toBe('rpc_success_data');
    });

    it('should trip the Circuit Breaker to OPEN state after consecutive failures exceed threshold', async () => {
      const breaker = service.getCircuitBreaker();
      const failAction = async () => {
        throw new Error('RPC Server Timeout');
      };

      // Exceed volume threshold (3) with 100% failure rate
      for (let i = 0; i < 3; i++) {
        await expect(service.executeRpc(failAction)).rejects.toThrow(
          'RPC Server Timeout',
        );
      }

      // Breaker must now be OPEN
      expect(breaker.opened).toBe(true);

      // Subsequent calls should fail fast without executing the action
      let actionExecuted = false;
      await expect(
        service.executeRpc(async () => {
          actionExecuted = true;
          return 'should_not_reach';
        }),
      ).rejects.toThrow();

      expect(actionExecuted).toBe(false);
    });
  });

  describe('RPC Error Propagation (No Mock Fallbacks)', () => {
    it('should throw and propagate error when getNonceOnChain fails', async () => {
      const mockRpc = (service as any).rpcServer;
      mockRpc.getAccount = jest
        .fn()
        .mockRejectedValue(new Error('RPC node unreachable'));

      await expect(
        service.getNonceOnChain(Keypair.random().publicKey()),
      ).rejects.toThrow('RPC node unreachable');
    });

    it('should return safe fallback 0.00 when getBalance fails on-chain', async () => {
      const mockRpc = (service as any).rpcServer;
      mockRpc.getAccount = jest
        .fn()
        .mockRejectedValue(new Error('Stellar RPC 503 Service Unavailable'));

      const balance = await service.getBalance(Keypair.random().publicKey());
      expect(balance).toBe('0.00');
    });

    it('should call getHealth through circuit breaker in checkConnection', async () => {
      const mockRpc = (service as any).rpcServer;
      mockRpc.getHealth = jest.fn().mockResolvedValue({ status: 'healthy' });

      const healthy = await service.checkConnection();
      expect(healthy).toBe(true);
      expect(mockRpc.getHealth).toHaveBeenCalled();

      mockRpc.getHealth = jest
        .fn()
        .mockRejectedValue(new Error('Health check failure'));
      const unhealthy = await service.checkConnection();
      expect(unhealthy).toBe(false);
    });
  });

  describe('FeeBumpTransaction & Subsidized Transfers', () => {
    it('should build and submit FeeBumpTransaction covering user transaction gas', async () => {
      const userKeypair = Keypair.random();
      const recipientKeypair = Keypair.random();
      const mockRpc = (service as any).rpcServer;

      mockRpc.getAccount = jest.fn().mockResolvedValue({
        sequenceNumber: () => '100',
      });

      mockRpc.simulateTransaction = jest.fn().mockResolvedValue({
        transactionData: 'mock_soroban_data',
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

      mockRpc.sendTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        hash: 'feebump_tx_hash_valid_123',
      });

      mockRpc.getTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        ledger: 12345,
      });

      const result = await service.executeSubsidizedTransfer(
        userKeypair.secret(),
        recipientKeypair.publicKey(),
        10,
      );

      expect(result.hash).toBe('feebump_tx_hash_valid_123');
      expect(result.status).toBe(1);
      expect(mockRpc.getAccount).toHaveBeenCalledWith(userKeypair.publicKey());
      expect(mockRpc.sendTransaction).toHaveBeenCalled();
    });

    it('should throw error if transaction simulation fails during subsidized transfer', async () => {
      const userKeypair = Keypair.random();
      const mockRpc = (service as any).rpcServer;

      mockRpc.getAccount = jest.fn().mockResolvedValue({
        sequenceNumber: () => '100',
      });

      mockRpc.simulateTransaction = jest.fn().mockResolvedValue({
        error: 'Simulation contract execution failed: insufficient balance',
      });

      jest.spyOn(StellarRpc.Api, 'isSimulationSuccess').mockReturnValue(false);

      await expect(
        service.executeSubsidizedTransfer(
          userKeypair.secret(),
          Keypair.random().publicKey(),
          50,
        ),
      ).rejects.toThrow(/Simulation failed/);
    });

    it('should throw error if sendTransaction returns status ERROR', async () => {
      const userKeypair = Keypair.random();
      const mockRpc = (service as any).rpcServer;

      mockRpc.getAccount = jest.fn().mockResolvedValue({
        sequenceNumber: () => '100',
      });

      mockRpc.simulateTransaction = jest.fn().mockResolvedValue({
        transactionData: 'mock_soroban_data',
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

      mockRpc.sendTransaction = jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResult: 'tx_failed',
      });

      await expect(
        service.executeSubsidizedTransfer(
          userKeypair.secret(),
          Keypair.random().publicKey(),
          10,
        ),
      ).rejects.toThrow(/Transaction submission error/);
    });
  });
});
