import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { RoleThrottlerGuard } from './role-throttler.guard';

describe('RoleThrottlerGuard', () => {
  let guard: RoleThrottlerGuard;
  let storageMock: any;

  beforeEach(async () => {
    storageMock = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 1,
        timeToExpire: 60000,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60000, limit: 100 }],
        }),
      ],
      providers: [
        RoleThrottlerGuard,
        { provide: ThrottlerStorage, useValue: storageMock },
      ],
    }).compile();

    await module.init();
    guard = module.get<RoleThrottlerGuard>(RoleThrottlerGuard);
  });

  const createMockContext = (user?: any, ip = '127.0.0.1') => {
    const req: any = {
      user,
      ip,
      headers: {},
    };

    const ctx: Partial<ExecutionContext> = {
      getType: jest.fn().mockReturnValue('http'),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: () => req,
        getResponse: () => ({ header: jest.fn() }),
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    };

    return { ctx: ctx as ExecutionContext, req };
  };

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('should use user id for tracker if authenticated', async () => {
    const tracker = await (guard as any).getTracker({ user: { id: 'user-123' } });
    expect(tracker).toBe('user:user-123');
  });

  it('should use IP for tracker if unauthenticated', async () => {
    const tracker = await (guard as any).getTracker({ ip: '192.168.1.50' });
    expect(tracker).toBe('192.168.1.50');
  });

  it('should dynamically adapt limits based on user role', async () => {
    const { ctx, req } = createMockContext({ id: 'u1', role: Role.HOGAR });
    const throttler = { name: 'default', ttl: 60000, limit: 100 };

    await guard['handleRequest']({
      context: ctx,
      limit: 100,
      ttl: 60000,
      throttler,
      blockDuration: 0,
      getTracker: (r) => (guard as any).getTracker(r),
      generateKey: (_c, suffix, name) => `${name}-${suffix}`,
    });

    expect(storageMock.increment).toHaveBeenCalledWith(
      expect.stringContaining('default-user:u1'),
      60000,
      60, // Adaptado para Role.HOGAR (60 req/min)
      0,
      'default',
    );
  });
});
