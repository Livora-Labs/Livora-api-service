import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { RedisService } from '../../redis/redis.service';
import { RegisterDto } from '../dto/register.dto';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

describe('OtpService (Isolated OTP Lifecycle & Security)', () => {
  let service: OtpService;
  let mockRedisService: any;

  const mockRegisterDto: RegisterDto = {
    email: 'eco.tester@livora.io',
    password: 'SecurePassword123!',
    role: Role.HOGAR,
    termsVersion: '1.0.0',
    privacyVersion: '1.0.0',
  };

  beforeEach(async () => {
    mockRedisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      ttl: jest.fn().mockResolvedValue(600),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  describe('generateAndStoreRegistrationOtp', () => {
    it('should generate a 6-digit code and store dual Redis keys with cooldown and TTL', async () => {
      const code = await service.generateAndStoreRegistrationOtp(mockRegisterDto);

      expect(code).toBeDefined();
      expect(code).toHaveLength(6);
      expect(/^\d{6}$/.test(code)).toBe(true);

      // Verify local keys
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:register:payload:eco.tester@livora.io',
        JSON.stringify(mockRegisterDto),
        1800,
      );
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:otp:cooldown:eco.tester@livora.io',
        '1',
        60,
      );

      // Verify colleague keys
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'otp:register:eco.tester@livora.io',
        expect.any(String),
        1800,
      );
    });
  });

  describe('verifyRegistrationOtp', () => {
    it('should return registerDto on valid OTP', async () => {
      const plainCode = '654321';
      const hashed = await bcrypt.hash(plainCode, 10);

      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.tester@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.tester@livora.io') {
          return hashed;
        }
        if (key === 'auth:otp:attempts:eco.tester@livora.io') {
          return '0';
        }
        return null;
      });

      const result = await service.verifyRegistrationOtp('eco.tester@livora.io', plainCode);
      expect(result.registerDto.email).toBe('eco.tester@livora.io');
      expect(result.isReviewerBypass).toBe(false);
    });

    it('should allow reviewer bypass code', async () => {
      const result = await service.verifyRegistrationOtp(
        'playstore.review@livora.pe',
        '123456',
      );
      expect(result.isReviewerBypass).toBe(true);
      expect(result.registerDto.email).toBe('playstore.review@livora.pe');
    });

    it('should throw BadRequestException on expired or missing payload', async () => {
      mockRedisService.get.mockResolvedValue(null);

      await expect(
        service.verifyRegistrationOtp('unknown@livora.io', '123456'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should block OTP if attempts exceed 5', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key.includes('payload')) return JSON.stringify(mockRegisterDto);
        if (key.includes('code')) return '$2a$10$dummyHash';
        if (key.includes('attempts')) return '5';
        return null;
      });

      await expect(
        service.verifyRegistrationOtp('eco.tester@livora.io', '000000'),
      ).rejects.toThrow(/Demasiados intentos fallidos/);
    });
  });

  describe('resendRegistrationOtp', () => {
    it('should reject resend during 60s cooldown', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key.includes('cooldown')) return '1';
        return null;
      });

      await expect(
        service.resendRegistrationOtp('eco.tester@livora.io'),
      ).rejects.toThrow(/Debes esperar 60 segundos/);
    });

    it('should generate new code when cooldown has passed and payload exists', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key.includes('payload')) return JSON.stringify(mockRegisterDto);
        return null;
      });
      mockRedisService.ttl.mockResolvedValue(1200);

      const newCode = await service.resendRegistrationOtp('eco.tester@livora.io');
      expect(newCode).toHaveLength(6);
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:otp:cooldown:eco.tester@livora.io',
        '1',
        60,
      );
    });
  });

  describe('clearRegistrationOtp', () => {
    it('should delete all dual Redis keys on cleanup', async () => {
      await service.clearRegistrationOtp('eco.tester@livora.io');

      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:register:payload:eco.tester@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:code:eco.tester@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'otp:register:eco.tester@livora.io',
      );
    });
  });
});
