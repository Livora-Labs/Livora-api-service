import { BadRequestException, ConflictException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RedisService } from '../../redis/redis.service';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let redisServiceMock: any;
  let reflectorMock: any;

  beforeEach(() => {
    redisServiceMock = {
      get: jest.fn(),
      set: jest.fn(),
      setNX: jest.fn(),
      del: jest.fn(),
    };

    reflectorMock = {
      getAllAndOverride: jest.fn(),
    };

    interceptor = new IdempotencyInterceptor(redisServiceMock, reflectorMock);
  });

  const createMockContext = (headers: Record<string, string> = {}) => {
    const req: any = { headers };
    const res: any = {
      statusCode: 200,
      status: jest.fn().mockReturnThis(),
      code: jest.fn().mockReturnThis(),
    };

    const ctx: Partial<ExecutionContext> = {
      getType: jest.fn().mockReturnValue('http'),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    };

    return { ctx: ctx as ExecutionContext, req, res };
  };

  it('should throw BadRequestException if Idempotency-Key is missing on required endpoint', (done) => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const { ctx } = createMockContext({});
    const next = { handle: () => of({ success: true }) };

    try {
      interceptor.intercept(ctx, next as any);
      done.fail('Should have thrown BadRequestException');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain("Idempotency-Key' es obligatorio");
      done();
    }
  });

  it('should return cached response immediately without calling next if key is cached in Redis', (done) => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const { ctx, res } = createMockContext({
      'idempotency-key': 'test-uuid-1234',
    });
    const cachedData = { statusCode: 202, body: { status: 'RECEIVED', batchId: 'b-1' } };
    redisServiceMock.get.mockResolvedValue(JSON.stringify(cachedData));

    const next = { handle: jest.fn() };

    interceptor.intercept(ctx, next as any).subscribe({
      next: (result) => {
        expect(result).toEqual(cachedData.body);
        expect(res.status).toHaveBeenCalledWith(202);
        expect(next.handle).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('should throw ConflictException if key is in PROCESSING state', (done) => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const { ctx } = createMockContext({
      'idempotency-key': 'test-uuid-processing',
    });
    redisServiceMock.get.mockResolvedValue('PROCESSING');

    const next = { handle: jest.fn() };

    interceptor.intercept(ctx, next as any).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toContain('Transaction currently being processed');
        expect(next.handle).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('should acquire lock, process request, save response with 24h TTL on success', (done) => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const { ctx, res } = createMockContext({
      'idempotency-key': 'new-transaction-uuid',
    });
    redisServiceMock.get.mockResolvedValue(null);
    redisServiceMock.setNX.mockResolvedValue(true);
    redisServiceMock.set.mockResolvedValue(undefined);

    const responsePayload = { success: true, txHash: '0x123' };
    const next = { handle: () => of(responsePayload) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: (result) => {
        expect(result).toEqual(responsePayload);
        expect(redisServiceMock.setNX).toHaveBeenCalledWith(
          'idempotency:new-transaction-uuid',
          'PROCESSING',
          60,
        );
        expect(redisServiceMock.set).toHaveBeenCalledWith(
          'idempotency:new-transaction-uuid',
          JSON.stringify({ statusCode: 200, body: responsePayload }),
          86400,
        );
        done();
      },
    });
  });

  it('should release lock on execution failure so subsequent calls can retry', (done) => {
    reflectorMock.getAllAndOverride.mockReturnValue(true);
    const { ctx } = createMockContext({
      'idempotency-key': 'failed-transaction-uuid',
    });
    redisServiceMock.get.mockResolvedValue(null);
    redisServiceMock.setNX.mockResolvedValue(true);
    redisServiceMock.del.mockResolvedValue(undefined);

    const next = {
      handle: () => throwError(() => new Error('Soroban RPC timeout')),
    };

    interceptor.intercept(ctx, next as any).subscribe({
      error: (err) => {
        expect(err.message).toBe('Soroban RPC timeout');
        expect(redisServiceMock.del).toHaveBeenCalledWith(
          'idempotency:failed-transaction-uuid',
        );
        done();
      },
    });
  });
});
