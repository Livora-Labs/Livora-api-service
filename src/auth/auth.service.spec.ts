import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { SessionService } from './services/session.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { RegisterDto } from './dto/register.dto';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

describe('AuthService (Decoupled Enterprise Authentication & Redis OTP Lifecycle)', () => {
  let service: AuthService;
  let mockUsersService: any;
  let mockPrismaService: any;
  let mockRedisService: any;
  let mockMailService: any;
  let mockPasswordService: any;
  let mockTokenService: any;
  let mockSessionService: any;

  const mockRegisterDto: RegisterDto = {
    email: 'eco.user@livora.io',
    password: 'SecurePassword123!',
    role: Role.HOGAR,
    termsVersion: '1.0.0',
    privacyVersion: '1.0.0',
    ipAddress: '190.236.1.100',
    userAgent: 'Mozilla/5.0 Test Agent',
    marketingAccepted: false,
  };

  beforeEach(async () => {
    mockPasswordService = {
      hash: jest.fn().mockResolvedValue('$2a$12$hashedPasswordExample'),
      compare: jest.fn().mockResolvedValue(true),
    };

    mockTokenService = {
      generateAccessToken: jest.fn().mockReturnValue('jwt-access-token-xyz'),
      generateTokens: jest.fn().mockReturnValue({
        accessToken: 'jwt-access-token-xyz',
        refreshToken: 'jwt-refresh-token-xyz',
      }),
    };

    mockSessionService = {
      createSession: jest.fn().mockResolvedValue('jwt-refresh-token-xyz'),
      rotateSession: jest.fn().mockResolvedValue({
        accessToken: 'jwt-access-token-xyz',
        refreshToken: 'jwt-refresh-token-rotated',
      }),
      invalidateSession: jest.fn().mockResolvedValue(undefined),
      invalidateAllUserSessions: jest.fn().mockResolvedValue(undefined),
    };

    mockPrismaService = {
      consentAudit: {
        create: jest.fn().mockResolvedValue({
          id: 'consent-audit-uuid-123',
          userId: 'local-user-uuid-123',
          ipAddress: '190.236.1.100',
          userAgent: 'Mozilla/5.0 Test Agent',
          termsVersion: '1.0.0',
          privacyVersion: '1.0.0',
          documentHash: 'somehash',
          consentedAt: new Date(),
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'local-user-uuid-123',
          email: 'eco.user@livora.io',
          role: Role.HOGAR,
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
          isActive: true,
          deletedAt: null,
          credentials: {
            id: 'cred-123',
            userId: 'local-user-uuid-123',
            passwordHash: '$2a$12$hashedPasswordExample',
            failedAttempts: 0,
            lockedUntil: null,
          },
        }),
      },
      userCredential: {
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    mockUsersService = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
        role: Role.HOGAR,
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        kycStatus: 'UNVERIFIED',
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
        role: Role.HOGAR,
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        kycStatus: 'UNVERIFIED',
      }),
    };

    mockRedisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      ttl: jest.fn().mockResolvedValue(600),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      exists: jest.fn().mockResolvedValue(false),
    };

    mockMailService = {
      sendOtpEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordRecoveryEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: TokenService, useValue: mockTokenService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: UsersService, useValue: mockUsersService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('should throw ConflictException if email is already registered in local database', async () => {
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'existing-user-id',
      });

      await expect(service.register(mockRegisterDto)).rejects.toThrow(
        ConflictException,
      );
      expect(mockRedisService.set).not.toHaveBeenCalled();
      expect(mockMailService.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('should decouple OTP state across Redis keys with payload TTL and cooldown', async () => {
      const result = await service.register(mockRegisterDto);

      expect(result).toEqual({
        message: 'Código de verificación enviado al correo electrónico',
        email: 'eco.user@livora.io',
      });

      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:register:payload:eco.user@livora.io',
        JSON.stringify(mockRegisterDto),
        1800,
      );

      const codeCall = mockRedisService.set.mock.calls.find(
        (call: any[]) => call[0] === 'auth:otp:code:eco.user@livora.io',
      );
      expect(codeCall).toBeDefined();
      expect(codeCall[2]).toBe(600);
      expect(typeof codeCall[1]).toBe('string');

      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
      expect(mockMailService.sendOtpEmail).toHaveBeenCalledWith(
        'eco.user@livora.io',
        expect.any(String),
      );
    });
  });

  describe('verifyEmail', () => {
    it('should create user, record consent audit and return session tokens on valid OTP', async () => {
      const plainCode = '123456';
      const hashedCode = await bcrypt.hash(plainCode, 10);

      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return hashedCode;
        }
        return null;
      });

      const result = await service.verifyEmail({
        email: 'eco.user@livora.io',
        code: plainCode,
      });

      expect(result).toEqual({
        accessToken: 'jwt-access-token-xyz',
        refreshToken: 'jwt-refresh-token-xyz',
        expiresIn: 3600,
        tokenType: 'bearer',
        user: {
          id: 'local-user-uuid-123',
          email: 'eco.user@livora.io',
          role: Role.HOGAR,
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        },
      });

      expect(mockPasswordService.hash).toHaveBeenCalledWith(mockRegisterDto.password);
      expect(mockUsersService.create).toHaveBeenCalledWith(
        expect.any(String),
        mockRegisterDto,
        '$2a$12$hashedPasswordExample',
      );
      expect(mockPrismaService.consentAudit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'local-user-uuid-123',
          ipAddress: '190.236.1.100',
          userAgent: 'Mozilla/5.0 Test Agent',
          termsVersion: '1.0.0',
          privacyVersion: '1.0.0',
          marketingAccepted: false,
          documentHash: expect.any(String),
        }),
      });

      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:register:payload:eco.user@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:code:eco.user@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
    });

    it('should throw BadRequestException on invalid OTP code and increment attempts', async () => {
      const plainCode = '123456';
      const wrongCode = '654321';
      const hashedCode = await bcrypt.hash(plainCode, 10);

      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return hashedCode;
        }
        return null;
      });

      mockRedisService.incr.mockResolvedValue(1);

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: wrongCode }),
      ).rejects.toThrow(
        new BadRequestException('El código de verificación es incorrecto'),
      );

      expect(mockRedisService.incr).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
    });
  });

  describe('login', () => {
    it('should return session tokens and user profile on successful login', async () => {
      const result = await service.login({
        email: 'eco.user@livora.io',
        password: 'SecurePassword123!',
      });

      expect(result).toEqual({
        accessToken: 'jwt-access-token-xyz',
        refreshToken: 'jwt-refresh-token-xyz',
        expiresIn: 3600,
        tokenType: 'bearer',
        user: {
          id: 'local-user-uuid-123',
          email: 'eco.user@livora.io',
          role: Role.HOGAR,
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
          kycStatus: 'UNVERIFIED',
        },
      });

      expect(mockPasswordService.compare).toHaveBeenCalledWith(
        'SecurePassword123!',
        '$2a$12$hashedPasswordExample',
      );
    });

    it('should throw UnauthorizedException on invalid credentials', async () => {
      mockPasswordService.compare.mockResolvedValue(false);

      await expect(
        service.login({
          email: 'eco.user@livora.io',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPrismaService.userCredential.update).toHaveBeenCalledWith({
        where: { userId: 'local-user-uuid-123' },
        data: { failedAttempts: 1 },
      });
    });

    it('should throw UnauthorizedException if account is temporarily locked', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
        role: Role.HOGAR,
        isActive: true,
        deletedAt: null,
        credentials: {
          id: 'cred-123',
          userId: 'local-user-uuid-123',
          passwordHash: '$2a$12$hashedPasswordExample',
          failedAttempts: 5,
          lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await expect(
        service.login({
          email: 'eco.user@livora.io',
          password: 'SecurePassword123!',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('Cuenta bloqueada temporalmente'),
        }),
      );
    });
  });

  describe('forgotPassword & resetPassword', () => {
    it('should generate token in Redis and send email on forgotPassword', async () => {
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
      });

      const result = await service.forgotPassword({ email: 'eco.user@livora.io' });

      expect(result).toEqual({
        message: 'Enlace de recuperación enviado exitosamente al correo electrónico',
      });
      expect(mockRedisService.set).toHaveBeenCalledWith(
        expect.stringContaining('auth:password-reset:token:'),
        'eco.user@livora.io',
        3600,
      );
      expect(mockMailService.sendPasswordRecoveryEmail).toHaveBeenCalledWith(
        'eco.user@livora.io',
        expect.stringContaining('/restablecer-contrasena?token='),
      );
    });

    it('should update password in PostgreSQL, revoke sessions, and delete token on resetPassword', async () => {
      mockRedisService.get.mockResolvedValue('eco.user@livora.io');
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
      });

      const result = await service.resetPassword({
        token: 'valid-reset-token',
        password: 'BrandNewSecurePassword123!',
      });

      expect(result).toEqual({
        message: 'Contraseña restablecida exitosamente',
      });

      expect(mockPasswordService.hash).toHaveBeenCalledWith('BrandNewSecurePassword123!');
      expect(mockPrismaService.userCredential.upsert).toHaveBeenCalledWith({
        where: { userId: 'local-user-uuid-123' },
        update: {
          passwordHash: '$2a$12$hashedPasswordExample',
          failedAttempts: 0,
          lockedUntil: null,
          lastPasswordChange: expect.any(Date),
        },
        create: {
          userId: 'local-user-uuid-123',
          passwordHash: '$2a$12$hashedPasswordExample',
          lastPasswordChange: expect.any(Date),
        },
      });
      expect(mockSessionService.invalidateAllUserSessions).toHaveBeenCalledWith('local-user-uuid-123');
      expect(mockRedisService.del).toHaveBeenCalledWith('auth:password-reset:token:valid-reset-token');
    });
  });
});
