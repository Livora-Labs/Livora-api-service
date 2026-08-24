import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { RegisterDto } from './dto/register.dto';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

describe('Adversarial M3 Verification — Redis OTP State Lifecycle & Attacks', () => {
  let service: AuthService;
  let mockSupabaseService: any;
  let mockUsersService: any;
  let mockRedisService: any;
  let mockMailService: any;
  let mockSupabaseClient: any;

  // In-memory simulated Redis with TTL tracking
  let redisMemory: Map<string, { value: string; expiresAt: number }>;

  const testEmail = 'adversary@livora.io';
  const testRegisterDto: RegisterDto = {
    email: testEmail,
    password: 'AdversarialPassword123!',
    name: 'Adversary Tester',
    phone: '+51999888777',
    role: Role.HOGAR,
  };

  beforeEach(async () => {
    redisMemory = new Map();

    mockRedisService = {
      set: jest.fn(async (key: string, value: string, ttlSeconds?: number) => {
        const expiresAt = ttlSeconds
          ? Date.now() + ttlSeconds * 1000
          : Infinity;
        redisMemory.set(key, { value, expiresAt });
      }),
      get: jest.fn(async (key: string) => {
        const entry = redisMemory.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          redisMemory.delete(key);
          return null;
        }
        return entry.value;
      }),
      del: jest.fn(async (key: string) => {
        redisMemory.delete(key);
      }),
      ttl: jest.fn(async (key: string) => {
        const entry = redisMemory.get(key);
        if (!entry) return -2;
        if (entry.expiresAt <= Date.now()) {
          redisMemory.delete(key);
          return -2;
        }
        if (entry.expiresAt === Infinity) return -1;
        return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
      }),
      incr: jest.fn(async (key: string) => {
        const entry = redisMemory.get(key);
        let count = 1;
        let expiresAt = Infinity;
        if (entry && entry.expiresAt > Date.now()) {
          count = parseInt(entry.value, 10) + 1;
          expiresAt = entry.expiresAt;
        }
        redisMemory.set(key, { value: count.toString(), expiresAt });
        return count;
      }),
      expire: jest.fn(async (key: string, seconds: number) => {
        const entry = redisMemory.get(key);
        if (!entry || entry.expiresAt <= Date.now()) return false;
        entry.expiresAt = Date.now() + seconds * 1000;
        return true;
      }),
      exists: jest.fn(async (key: string) => {
        const entry = redisMemory.get(key);
        if (!entry) return false;
        if (entry.expiresAt <= Date.now()) {
          redisMemory.delete(key);
          return false;
        }
        return true;
      }),
    };

    mockSupabaseClient = {
      auth: {
        admin: {
          createUser: jest.fn().mockResolvedValue({
            data: { user: { id: 'supabase-adv-id-123', email: testEmail } },
            error: null,
          }),
          deleteUser: jest.fn().mockResolvedValue({ error: null }),
        },
        signInWithPassword: jest.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'adv-jwt-access-token',
              refresh_token: 'adv-jwt-refresh-token',
              expires_in: 3600,
              token_type: 'bearer',
            },
            user: { id: 'supabase-adv-id-123', email: testEmail },
          },
          error: null,
        }),
      },
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient),
    };

    mockUsersService = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'local-adv-id-123',
        email: testEmail,
        role: Role.HOGAR,
        walletAddress: '0xadversarialwalletaddress123456789012',
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'local-adv-id-123',
        email: testEmail,
        role: Role.HOGAR,
        walletAddress: '0xadversarialwalletaddress123456789012',
      }),
    };

    mockMailService = {
      sendOtpEmail: jest.fn().mockResolvedValue(undefined),
    };

    const mockPrismaService = {
      consentAudit: {
        create: jest.fn().mockResolvedValue({
          id: 'consent-audit-uuid',
          userId: 'local-adv-id-123',
          ipAddress: '127.0.0.1',
          userAgent: 'unknown',
          termsVersion: '1.0.0',
          privacyVersion: '1.0.0',
          documentHash: 'hash',
          consentedAt: new Date(),
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: UsersService, useValue: mockUsersService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('Criterion 1: Registration Payload 600s TTL is NOT extended by resendOtp', () => {
    it('should maintain the original registration payload expiration across multiple resendOtp calls', async () => {
      // 1. Initial Registration at T=0
      await service.register(testRegisterDto);

      const payloadKey = `auth:register:payload:${testEmail}`;
      const initialEntry = redisMemory.get(payloadKey);
      expect(initialEntry).toBeDefined();
      const initialExpiresAt = initialEntry!.expiresAt;

      // Simulate 120 seconds elapsed (T=120)
      const nowAtT120 = Date.now() + 120 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT120);

      // Cooldown expired at T=60, so at T=120 resendOtp is allowed
      await service.resendOtp({ email: testEmail });

      // Check payload entry: expiresAt must be exactly identical to initialExpiresAt
      const entryAfterResend = redisMemory.get(payloadKey);
      expect(entryAfterResend).toBeDefined();
      expect(entryAfterResend!.expiresAt).toBe(initialExpiresAt);

      // Remaining TTL of payload should now be ~480s (600 - 120), NOT 600s
      const remainingTtl = await mockRedisService.ttl(payloadKey);
      expect(remainingTtl).toBe(480);

      // Simulate another 100 seconds elapsed (T=220)
      const nowAtT220 = Date.now() + 100 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT220);

      // Resend OTP again
      await service.resendOtp({ email: testEmail });

      // Verify again: payload entry expiresAt is NEVER modified or refreshed
      const entryAfterSecondResend = redisMemory.get(payloadKey);
      expect(entryAfterSecondResend!.expiresAt).toBe(initialExpiresAt);
      expect(await mockRedisService.ttl(payloadKey)).toBe(380);

      jest.restoreAllMocks();
    });
  });

  describe('Criterion 2: New OTP code expiration is clamped to remaining TTL of registration payload', () => {
    it('should clamp new OTP TTL to exactly remaining payload TTL, even if less than 600s or 60s', async () => {
      await service.register(testRegisterDto);

      const payloadKey = `auth:register:payload:${testEmail}`;
      const codeKey = `auth:otp:code:${testEmail}`;

      // Simulate 550s elapsed (only 50s remaining on the 600s registration payload)
      const nowAtT550 = Date.now() + 550 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT550);

      await service.resendOtp({ email: testEmail });

      // Check code entry: TTL must be clamped to 50s
      const codeEntry = redisMemory.get(codeKey);
      expect(codeEntry).toBeDefined();
      expect(Math.abs(codeEntry!.expiresAt - redisMemory.get(payloadKey)!.expiresAt)).toBeLessThanOrEqual(5);

      const codeRemainingTtl = await mockRedisService.ttl(codeKey);
      expect(codeRemainingTtl).toBe(50);

      // Simulate 51s later (T=601) -> both payload and code expire simultaneously
      const nowAtT601 = Date.now() + 51 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT601);

      expect(await mockRedisService.get(payloadKey)).toBeNull();
      expect(await mockRedisService.get(codeKey)).toBeNull();

      // Calling verifyEmail at T=601 must fail due to expiration
      await expect(
        service.verifyEmail({ email: testEmail, code: '123456' }),
      ).rejects.toThrow(BadRequestException);

      jest.restoreAllMocks();
    });

    it('should reject resendOtp if payload TTL has already expired (TTL <= 0)', async () => {
      await service.register(testRegisterDto);

      // Simulate 605s elapsed (registration expired)
      const nowAtT605 = Date.now() + 605 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT605);

      await expect(service.resendOtp({ email: testEmail })).rejects.toThrow(
        new BadRequestException(
          'El registro temporal no existe o ha expirado. Por favor regístrate de nuevo.',
        ),
      );

      jest.restoreAllMocks();
    });
  });

  describe('Criterion 3: OTP cooldown (60s) rejects rapid consecutive resend requests', () => {
    it('should block immediate resendOtp calls within 60s cooldown window and allow after 60s', async () => {
      await service.register(testRegisterDto);

      // Attempt immediate resend at T=5s
      const nowAtT5 = Date.now() + 5 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT5);

      await expect(service.resendOtp({ email: testEmail })).rejects.toThrow(
        new BadRequestException(
          'Debes esperar 60 segundos antes de reenviar otro código',
        ),
      );

      // Attempt at T=59s (still within 60s cooldown)
      const nowAtT59 = Date.now() + 54 * 1000; // relative to T=5s -> T=59s
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT59);

      await expect(service.resendOtp({ email: testEmail })).rejects.toThrow(
        new BadRequestException(
          'Debes esperar 60 segundos antes de reenviar otro código',
        ),
      );

      // Attempt at T=61s (cooldown expired)
      const nowAtT61 = Date.now() + 2 * 1000; // relative to T=59s -> T=61s
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT61);

      const res = await service.resendOtp({ email: testEmail });
      expect(res.message).toBe('Código de verificación reenviado exitosamente');

      // Now at T=62s, another cooldown is active!
      const nowAtT62 = Date.now() + 1 * 1000;
      jest.spyOn(Date, 'now').mockReturnValue(nowAtT62);

      await expect(service.resendOtp({ email: testEmail })).rejects.toThrow(
        new BadRequestException(
          'Debes esperar 60 segundos antes de reenviar otro código',
        ),
      );

      jest.restoreAllMocks();
    });
  });

  describe('Criterion 4: Exceeding 5 failed OTP attempts invalidates session', () => {
    it('should allow up to 4 failed attempts, and on the 5th failed attempt, delete code and lock session', async () => {
      await service.register(testRegisterDto);

      const lastSentOtp = (mockMailService.sendOtpEmail as jest.Mock).mock
        .calls[0][1];
      const codeKey = `auth:otp:code:${testEmail}`;
      const attemptsKey = `auth:otp:attempts:${testEmail}`;

      // Attempts 1 to 4 with incorrect code
      for (let i = 1; i <= 4; i++) {
        await expect(
          service.verifyEmail({ email: testEmail, code: '000000' }),
        ).rejects.toThrow(
          new BadRequestException('El código de verificación es incorrecto'),
        );

        const attempts = await mockRedisService.get(attemptsKey);
        expect(attempts).toBe(i.toString());
        // Code should still exist
        expect(await mockRedisService.get(codeKey)).not.toBeNull();
      }

      // 5th attempt with wrong code: must delete code and throw blocked exception
      await expect(
        service.verifyEmail({ email: testEmail, code: '000000' }),
      ).rejects.toThrow(
        new BadRequestException(
          'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
        ),
      );

      // Code key MUST be purged/deleted
      expect(await mockRedisService.get(codeKey)).toBeNull();

      // 6th attempt (even with the previously CORRECT code) must fail because code is gone and attempts >= 5
      await expect(
        service.verifyEmail({ email: testEmail, code: lastSentOtp }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow successful verification on 5th attempt if the code is correct', async () => {
      await service.register(testRegisterDto);
      const correctOtp = (mockMailService.sendOtpEmail as jest.Mock).mock
        .calls[0][1];

      // Fail 4 times
      for (let i = 1; i <= 4; i++) {
        await expect(
          service.verifyEmail({ email: testEmail, code: '999999' }),
        ).rejects.toThrow(
          new BadRequestException('El código de verificación es incorrecto'),
        );
      }

      // 5th attempt with correct code -> SUCCESS
      const res = await service.verifyEmail({
        email: testEmail,
        code: correctOtp,
      });
      expect(res.accessToken).toBe('adv-jwt-access-token');

      // All keys must be wiped
      expect(redisMemory.size).toBe(0);
    });
  });
});
