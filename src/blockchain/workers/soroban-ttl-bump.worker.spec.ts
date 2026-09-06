import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Keypair, rpc as StellarRpc } from '@stellar/stellar-sdk';
import { SorobanTtlBumpWorker, TTL_BUMP_JOB_NAME } from './soroban-ttl-bump.worker';
import { StellarRpcManagerService } from '../services/stellar-rpc-manager.service';

describe('SorobanTtlBumpWorker', () => {
  let worker: SorobanTtlBumpWorker;
  let rpcManagerMock: any;
  let configServiceMock: any;
  let queueMock: any;

  const mockAdminKp = Keypair.random();

  beforeEach(async () => {
    jest.spyOn(StellarRpc.Api, 'isSimulationSuccess').mockReturnValue(true);

    rpcManagerMock = {
      executeWithFailover: jest.fn(),
    };

    configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === 'SOROBAN_REGISTRY_CONTRACT_ID') return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
        if (key === 'SOROBAN_TOKEN_CONTRACT_ID') return 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2KM';
        if (key === 'STELLAR_ADMIN_SECRET') return mockAdminKp.secret();
        if (key === 'STELLAR_NETWORK_PASSPHRASE') return 'Test SDF Network ; September 2015';
        return null;
      }),
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SorobanTtlBumpWorker,
        { provide: StellarRpcManagerService, useValue: rpcManagerMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: 'BullQueue_blockchain-queue', useValue: queueMock },
      ],
    }).compile();

    worker = module.get<SorobanTtlBumpWorker>(SorobanTtlBumpWorker);
  });

  it('should be defined and register recurring cron onModuleInit', async () => {
    expect(worker).toBeDefined();
    await worker.onModuleInit();
    expect(queueMock.add).toHaveBeenCalledWith(
      TTL_BUMP_JOB_NAME,
      expect.objectContaining({ extendTo: expect.any(Number) }),
      expect.objectContaining({
        repeat: { pattern: '0 2 * * *' },
      }),
    );
  });

  it('should process TTL bump job for configured contracts', async () => {
    rpcManagerMock.executeWithFailover.mockImplementation(async (callback) => {
      const mockServer = {
        getAccount: jest.fn().mockResolvedValue({
          accountId: () => mockAdminKp.publicKey(),
          sequenceNumber: () => '100',
          incrementSequenceNumber: jest.fn(),
        }),
        simulateTransaction: jest.fn().mockResolvedValue({ minResourceFee: '100' }),
        isSimulationSuccess: jest.fn().mockReturnValue(true),
        prepareTransaction: jest.fn().mockImplementation((tx) => tx),
        sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'tx-hash-123' }),
      };
      return callback(mockServer);
    });

    const job = {
      id: '123',
      name: TTL_BUMP_JOB_NAME,
      data: { extendTo: 3110400 },
    };

    const result = await worker.process(job as any);

    expect(result.bumped).toBe(2);
    expect(rpcManagerMock.executeWithFailover).toHaveBeenCalledTimes(2);
  });
});
