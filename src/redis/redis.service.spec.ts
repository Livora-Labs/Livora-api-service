import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService', () => {
  let service: RedisService;
  let mockRedisClient: any;

  beforeEach(async () => {
    mockRedisClient = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
      ttl: jest.fn().mockResolvedValue(300),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'REDIS_HOST') return 'localhost';
              if (key === 'REDIS_PORT') return 6379;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
    (service as any).client = mockRedisClient;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getClient', () => {
    it('should return underlying ioredis client', () => {
      expect(service.getClient()).toBe(mockRedisClient);
    });
  });

  describe('set', () => {
    it('should call set without TTL', async () => {
      await service.set('test-key', 'test-value');
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'test-value',
      );
    });

    it('should call set with EX option when TTL is provided', async () => {
      await service.set('test-key', 'test-value', 600);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'test-value',
        'EX',
        600,
      );
    });
  });

  describe('get', () => {
    it('should retrieve key value', async () => {
      mockRedisClient.get.mockResolvedValue('stored-data');
      const result = await service.get('test-key');
      expect(mockRedisClient.get).toHaveBeenCalledWith('test-key');
      expect(result).toBe('stored-data');
    });

    it('should return null when key does not exist', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      const result = await service.get('missing-key');
      expect(result).toBeNull();
    });
  });

  describe('del', () => {
    it('should delete specified key', async () => {
      await service.del('test-key');
      expect(mockRedisClient.del).toHaveBeenCalledWith('test-key');
    });
  });

  describe('ping', () => {
    it('should return PONG from Redis client', async () => {
      const result = await service.ping();
      expect(mockRedisClient.ping).toHaveBeenCalled();
      expect(result).toBe('PONG');
    });
  });

  describe('ttl', () => {
    it('should return remaining TTL in seconds', async () => {
      mockRedisClient.ttl.mockResolvedValue(450);
      const result = await service.ttl(
        'auth:register:payload:test@example.com',
      );
      expect(mockRedisClient.ttl).toHaveBeenCalledWith(
        'auth:register:payload:test@example.com',
      );
      expect(result).toBe(450);
    });

    it('should return negative values when key has no TTL or does not exist', async () => {
      mockRedisClient.ttl.mockResolvedValue(-2);
      const result = await service.ttl('non-existent-key');
      expect(result).toBe(-2);
    });
  });

  describe('incr', () => {
    it('should increment key counter and return new value', async () => {
      mockRedisClient.incr.mockResolvedValue(3);
      const result = await service.incr('auth:otp:attempts:test@example.com');
      expect(mockRedisClient.incr).toHaveBeenCalledWith(
        'auth:otp:attempts:test@example.com',
      );
      expect(result).toBe(3);
    });
  });

  describe('expire', () => {
    it('should return true when TTL is successfully set (expire returns 1)', async () => {
      mockRedisClient.expire.mockResolvedValue(1);
      const result = await service.expire(
        'auth:otp:attempts:test@example.com',
        300,
      );
      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        'auth:otp:attempts:test@example.com',
        300,
      );
      expect(result).toBe(true);
    });

    it('should return false when key does not exist (expire returns 0)', async () => {
      mockRedisClient.expire.mockResolvedValue(0);
      const result = await service.expire('missing-key', 300);
      expect(result).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true when key exists (exists returns 1)', async () => {
      mockRedisClient.exists.mockResolvedValue(1);
      const result = await service.exists('auth:otp:cooldown:test@example.com');
      expect(mockRedisClient.exists).toHaveBeenCalledWith(
        'auth:otp:cooldown:test@example.com',
      );
      expect(result).toBe(true);
    });

    it('should return false when key does not exist (exists returns 0)', async () => {
      mockRedisClient.exists.mockResolvedValue(0);
      const result = await service.exists('auth:otp:cooldown:test@example.com');
      expect(result).toBe(false);
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect Redis client', () => {
      service.onModuleDestroy();
      expect(mockRedisClient.disconnect).toHaveBeenCalled();
    });
  });
});
