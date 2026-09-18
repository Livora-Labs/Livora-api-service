import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { RoleThrottlerGuard } from './role-throttler.guard';
import * as jwt from 'jsonwebtoken';

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

  it('should resolve JWT in canActivate and isolate users behind identical CGNAT IP', async () => {
    process.env.SUPABASE_JWT_SECRET = 'test_jwt_secret_key_for_cgnat_test!';
    const tokenUser1 = jwt.sign(
      { sub: 'cgnat-user-1', role: Role.HOGAR },
      process.env.SUPABASE_JWT_SECRET,
    );
    const tokenUser2 = jwt.sign(
      { sub: 'cgnat-user-2', role: Role.ADMIN },
      process.env.SUPABASE_JWT_SECRET,
    );

    const cgnatIp = '181.176.50.10';

    // Request 1: User 1
    const { ctx: ctx1, req: req1 } = createMockContext(undefined, cgnatIp);
    req1.headers.authorization = `Bearer ${tokenUser1}`;
    await (guard as any).resolveUserFromAuthHeader(req1);

    expect(req1.user).toBeDefined();
    expect(req1.user.id).toBe('cgnat-user-1');
    const tracker1 = await (guard as any).getTracker(req1);
    expect(tracker1).toBe('user:cgnat-user-1');

    // Request 2: User 2 (same CGNAT IP)
    const { ctx: ctx2, req: req2 } = createMockContext(undefined, cgnatIp);
    req2.headers.authorization = `Bearer ${tokenUser2}`;
    await (guard as any).resolveUserFromAuthHeader(req2);

    expect(req2.user).toBeDefined();
    expect(req2.user.id).toBe('cgnat-user-2');
    const tracker2 = await (guard as any).getTracker(req2);
    expect(tracker2).toBe('user:cgnat-user-2');

    // Ensure trackers are completely distinct despite identical IP
    expect(tracker1).not.toBe(tracker2);
  });
});
