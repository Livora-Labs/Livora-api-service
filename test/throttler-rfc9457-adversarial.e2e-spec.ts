import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageRecord,
} from '@nestjs/throttler';
import request from 'supertest';
import {
  GlobalExceptionFilter,
  ProblemDetails,
} from '../src/common/filters/global-exception.filter';

class MockDistributedRedisThrottlerStorage implements ThrottlerStorage {
  private storage = new Map<string, { count: number; expiresAt: number }>();

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const storageKey = `{${key}:${throttlerName}}:hits`;
    const now = Date.now();
    const entry = this.storage.get(storageKey);

    if (!entry || entry.expiresAt <= now) {
      this.storage.set(storageKey, { count: 1, expiresAt: now + ttl });
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }

    entry.count += 1;
    const isBlocked = entry.count > limit;
    return {
      totalHits: entry.count,
      timeToExpire: Math.ceil((entry.expiresAt - now) / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
    };
  }

  reset() {
    this.storage.clear();
  }
}

@Controller('auth')
class MockAuthController {
  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('login')
  login() {
    return { token: 'auth-jwt-123' };
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('verify-email')
  verifyEmail() {
    return { verified: true };
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('resend-otp')
  resendOtp() {
    return { resent: true };
  }
}

@Controller('wallets')
class MockWalletsController {
  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  sendTransaction() {
    return { txHash: 'stellar-hash-abc' };
  }
}

@Controller('stores')
class MockStoresController {
  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('settlements')
  createSettlement() {
    return { settlementId: 'settle-xyz' };
  }
}

@Controller('public')
class MockPublicController {
  @Get('items')
  getItems() {
    return { items: ['plastic', 'glass', 'paper'] };
  }
}

describe('Adversarial M3 Verification — Named Throttlers & RFC 9457 Compliance', () => {
  let app: NestFastifyApplication;
  let mockStorage: MockDistributedRedisThrottlerStorage;

  beforeAll(async () => {
    mockStorage = new MockDistributedRedisThrottlerStorage();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRootAsync({
          useFactory: () => ({
            throttlers: [
              {
                name: 'default',
                ttl: 60000,
                limit: 100,
              },
              {
                name: 'auth_strict',
                ttl: 60000,
                limit: 5,
                skipIf: (context: any) => {
                  const handler = context.getHandler();
                  const classRef = context.getClass();
                  const hasLimit =
                    Reflect.getMetadata(
                      'THROTTLER:LIMITauth_strict',
                      handler,
                    ) !== undefined ||
                    Reflect.getMetadata(
                      'THROTTLER:LIMITauth_strict',
                      classRef,
                    ) !== undefined;
                  return !hasLimit;
                },
              },
              {
                name: 'web3_transactions',
                ttl: 60000,
                limit: 10,
                skipIf: (context: any) => {
                  const handler = context.getHandler();
                  const classRef = context.getClass();
                  const hasLimit =
                    Reflect.getMetadata(
                      'THROTTLER:LIMITweb3_transactions',
                      handler,
                    ) !== undefined ||
                    Reflect.getMetadata(
                      'THROTTLER:LIMITweb3_transactions',
                      classRef,
                    ) !== undefined;
                  return !hasLimit;
                },
              },
            ],
            storage: mockStorage,
          }),
        }),
      ],
      controllers: [
        MockAuthController,
        MockWalletsController,
        MockStoresController,
        MockPublicController,
      ],
      providers: [
        {
          provide: APP_GUARD,
          useClass: ThrottlerGuard,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );

    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    mockStorage.reset();
  });

  describe('RFC 9457 Schema Compliance on HTTP 429 Too Many Requests', () => {
    it('returns strict RFC 9457 problem details on throttled auth_strict request (6th call)', async () => {
      const clientIp = '198.51.100.77';

      // 5 requests allowed
      for (let i = 1; i <= 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .set('X-Forwarded-For', clientIp)
          .expect(201);
      }

      // 6th request rejected with 429
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', clientIp)
        .expect(429);

      // Verify RFC 9457 Content-Type header
      expect(res.headers['content-type']).toContain('application/problem+json');

      const body = res.body as ProblemDetails;

      // Verify RFC 9457 fields
      expect(body.type).toBe('https://api.livora.org/errors/too_many_requests');
      expect(body.title).toBe('Too Many Requests');
      expect(body.status).toBe(429);
      expect(body.detail).toContain('ThrottlerException');
      expect(body.instance).toBe('/auth/login');
    });

    it('returns strict RFC 9457 problem details on throttled web3_transactions request (11th call)', async () => {
      const clientIp = '203.0.113.88';

      // 10 transactions allowed
      for (let i = 1; i <= 10; i++) {
        await request(app.getHttpServer())
          .post('/wallets/transactions')
          .set('X-Forwarded-For', clientIp)
          .expect(202);
      }

      // 11th call rejected with 429
      const res = await request(app.getHttpServer())
        .post('/wallets/transactions')
        .set('X-Forwarded-For', clientIp)
        .expect(429);

      expect(res.headers['content-type']).toContain('application/problem+json');
      const body = res.body as ProblemDetails;
      expect(body.type).toBe('https://api.livora.org/errors/too_many_requests');
      expect(body.title).toBe('Too Many Requests');
      expect(body.status).toBe(429);
      expect(body.instance).toBe('/wallets/transactions');
    });
  });

  describe('Throttler Isolation & IP Segregation', () => {
    it('throttles auth_strict without cross-contaminating unrelated public endpoints for same IP', async () => {
      const clientIp = '192.0.2.150';

      // Exhaust auth_strict (5 calls)
      for (let i = 1; i <= 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .set('X-Forwarded-For', clientIp)
          .expect(201);
      }

      // 6th auth call fails
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', clientIp)
        .expect(429);

      // Public endpoint on default tier MUST still succeed for same IP
      const publicRes = await request(app.getHttpServer())
        .get('/public/items')
        .set('X-Forwarded-For', clientIp)
        .expect(200);

      expect(publicRes.body.items).toHaveLength(3);
    });

    it('handles multiple chained proxies in X-Forwarded-For correctly', async () => {
      const clientIpHeader = '203.0.113.45, 10.0.0.1, 10.0.0.2';

      for (let i = 1; i <= 5; i++) {
        await request(app.getHttpServer())
          .post('/auth/verify-email')
          .set('X-Forwarded-For', clientIpHeader)
          .expect(201);
      }

      // 6th request throttled
      await request(app.getHttpServer())
        .post('/auth/verify-email')
        .set('X-Forwarded-For', clientIpHeader)
        .expect(429);
    });
  });
});
