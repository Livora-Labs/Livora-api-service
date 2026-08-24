import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
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
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

// Mock Redis Throttler Storage for isolated unit/e2e tests without external dependencies
class MockRedisThrottlerStorage implements ThrottlerStorage {
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

@Controller('auth-test')
class TestAuthController {
  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('register')
  register() {
    return { success: true, message: 'OTP sent' };
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('resend-otp')
  resendOtp() {
    return { success: true, message: 'OTP resent' };
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('login')
  login() {
    return { success: true, token: 'jwt-xyz' };
  }
}

@Controller('web3-test')
class TestWeb3Controller {
  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  sendTransaction() {
    return { success: true, txId: 'stellar-tx-123' };
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('redemptions/confirm')
  confirmRedemption() {
    return { success: true, status: 'CONFIRMED' };
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('settlements')
  requestSettlement() {
    return { success: true, settlementId: 'settle-123' };
  }
}

@Controller('default-test')
class TestDefaultController {
  @Get('query')
  getQuery() {
    return { success: true, data: [1, 2, 3] };
  }
}

describe('Distributed Rate Limiting & Named Throttlers (E2E)', () => {
  let app: NestFastifyApplication;
  let mockStorage: MockRedisThrottlerStorage;

  beforeAll(async () => {
    mockStorage = new MockRedisThrottlerStorage();

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
        TestAuthController,
        TestWeb3Controller,
        TestDefaultController,
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

  describe('auth_strict Named Throttler (Limit: 5 requests / 60s)', () => {
    it('should allow 5 consecutive requests and block the 6th with 429 Too Many Requests', async () => {
      // First 5 requests should succeed with 201 Created
      for (let i = 1; i <= 5; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth-test/register')
          .set('X-Forwarded-For', '198.51.100.50')
          .expect(201);
        expect(res.body).toEqual({ success: true, message: 'OTP sent' });
      }

      // 6th request should be throttled
      const throttledRes = await request(app.getHttpServer())
        .post('/auth-test/register')
        .set('X-Forwarded-For', '198.51.100.50')
        .expect(429);

      expect(throttledRes.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(throttledRes.body.status).toBe(429);
      expect(throttledRes.body.title).toBe('Too Many Requests');
      expect(throttledRes.body.detail).toContain('ThrottlerException');
    });

    it('should enforce distinct limits per client IP', async () => {
      // Consume 5 requests for IP-A
      for (let i = 1; i <= 5; i++) {
        await request(app.getHttpServer())
          .post('/auth-test/login')
          .set('X-Forwarded-For', '203.0.113.10')
          .expect(201);
      }

      // IP-A is blocked
      await request(app.getHttpServer())
        .post('/auth-test/login')
        .set('X-Forwarded-For', '203.0.113.10')
        .expect(429);

      // IP-B is still allowed
      const resB = await request(app.getHttpServer())
        .post('/auth-test/login')
        .set('X-Forwarded-For', '203.0.113.20')
        .expect(201);
      expect(resB.body.success).toBe(true);
    });
  });

  describe('web3_transactions Named Throttler (Limit: 10 requests / 60s)', () => {
    it('should allow 10 consecutive transactions and block the 11th with 429 Too Many Requests', async () => {
      // 10 transactions allowed
      for (let i = 1; i <= 10; i++) {
        const res = await request(app.getHttpServer())
          .post('/web3-test/transactions')
          .set('X-Forwarded-For', '192.0.2.1')
          .expect(202);
        expect(res.body.success).toBe(true);
      }

      // 11th transaction blocked
      const throttledRes = await request(app.getHttpServer())
        .post('/web3-test/transactions')
        .set('X-Forwarded-For', '192.0.2.1')
        .expect(429);

      expect(throttledRes.body.status).toBe(429);
      expect(throttledRes.body.title).toBe('Too Many Requests');
    });

    it('should enforce 10 request limit on redemption confirmation endpoint and block subsequent requests', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await request(app.getHttpServer())
          .post('/web3-test/redemptions/confirm')
          .set('X-Forwarded-For', '192.0.2.55')
          .expect(201);
        expect(res.body.success).toBe(true);
      }

      // 11th call is blocked
      await request(app.getHttpServer())
        .post('/web3-test/redemptions/confirm')
        .set('X-Forwarded-For', '192.0.2.55')
        .expect(429);
    });
  });

  describe('default Named Throttler (Limit: 100 requests / 60s)', () => {
    it('should allow more than 10 requests under default quota without throttling', async () => {
      for (let i = 1; i <= 15; i++) {
        const res = await request(app.getHttpServer())
          .get('/default-test/query')
          .set('X-Forwarded-For', '198.51.100.99')
          .expect(200);
        expect(res.body.success).toBe(true);
      }
    });
  });
});
