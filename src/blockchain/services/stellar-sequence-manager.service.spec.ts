import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarSequenceManager } from './stellar-sequence-manager.service';
import { RedisService } from '../../redis/redis.service';

describe('StellarSequenceManager (Channel Accounts Pool & Distributed Lock)', () => {
  let manager: StellarSequenceManager;
  let configService: ConfigService;
  let redisService: RedisService;
  let mockRedisClient: any;

  const channelKey1 = Keypair.random();
  const channelKey2 = Keypair.random();
  const workerKey = Keypair.random();

  beforeEach(async () => {
    mockRedisClient = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarSequenceManager,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WORKER_SECRET_KEY') return workerKey.secret();
              if (key === 'STELLAR_CHANNEL_SECRET_KEYS')
                return `${channelKey1.secret()},${channelKey2.secret()}`;
              return null;
            }),
          },
        },
        {
          provide: RedisService,
          useValue: {
            getClient: () => mockRedisClient,
          },
        },
      ],
    }).compile();

    manager = module.get<StellarSequenceManager>(StellarSequenceManager);
    configService = module.get<ConfigService>(ConfigService);
    redisService = module.get<RedisService>(RedisService);
    manager.onModuleInit();
  });

  afterEach(() => {
    manager.onModuleDestroy();
  });

  it('should initialize channel pool with configured secret keys', () => {
    expect(manager.getPoolSize()).toBe(2);
  });

  it('should lease available channel accounts concurrently without collision', async () => {
    const leasedAccount1 = await manager.acquireChannelAccount();
    const leasedAccount2 = await manager.acquireChannelAccount();

    expect(leasedAccount1.publicKey()).not.toBe(leasedAccount2.publicKey());

    // Release account 1 and ensure it can be leased again
    manager.releaseChannelAccount(leasedAccount1);
    const leasedAccount3 = await manager.acquireChannelAccount();
    expect(leasedAccount3.publicKey()).toBe(leasedAccount1.publicKey());

    manager.releaseChannelAccount(leasedAccount2);
    manager.releaseChannelAccount(leasedAccount3);
  });

  it('should execute task inside withChannelAccount and automatically release keypair', async () => {
    let usedPubkey = '';
    const result = await manager.withChannelAccount(async (keypair) => {
      usedPubkey = keypair.publicKey();
      return 'tx_success';
    });

    expect(result).toBe('tx_success');
    expect(usedPubkey).toBeDefined();

    // The keypair should now be free again
    const nextLease = await manager.acquireChannelAccount();
    expect(nextLease).toBeDefined();
    manager.releaseChannelAccount(nextLease);
  });

  it('should execute operation protected by Redis atomic mutex lock', async () => {
    const testPubkey = Keypair.random().publicKey();

    const res = await manager.withAccountLock(testPubkey, async () => {
      return 42;
    });

    expect(res).toBe(42);
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `stellar:lock:seq:${testPubkey}`,
      expect.any(String),
      'PX',
      15000,
      'NX',
    );
    expect(mockRedisClient.eval).toHaveBeenCalled();
  });
});
