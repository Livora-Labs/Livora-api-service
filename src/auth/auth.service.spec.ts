import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { RegisterDto } from './dto/register.dto';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

describe('AuthService (Redis OTP Separation & Lifecycle)', () => {
  let service: AuthService;
  let mockSupabaseService: any;
  let mockUsersService: any;
  let mockPrismaService: any;
  let mockRedisService: any;
  let mockMailService: any;
  let mockSupabaseClient: any;

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
    mockSupabaseClient = {
      auth: {
        admin: {
          createUser: jest.fn().mockResolvedValue({
            data: {
              user: {
                id: 'supabase-user-uuid-123',
                email: 'eco.user@livora.io',
              },
            },
            error: null,
          }),
          deleteUser: jest.fn().mockResolvedValue({ error: null }),
          updateUserById: jest.fn().mockResolvedValue({ data: { user: {} }, error: null }),
        },
        signInWithPassword: jest.fn().mockResolvedValue({
          data: {
            session: {
              access_token: 'jwt-access-token-xyz',
              refresh_token: 'jwt-refresh-token-xyz',
              expires_in: 3600,
              token_type: 'bearer',
            },
            user: { id: 'supabase-user-uuid-123', email: 'eco.user@livora.io' },
          },
          error: null,
        }),
      },
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient),
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
    };

    mockUsersService = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
        role: Role.HOGAR,
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'local-user-uuid-123',
        email: 'eco.user@livora.io',
        role: Role.HOGAR,
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
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
        { provide: SupabaseService, useValue: mockSupabaseService },
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

    it('should decouple OTP state across 3 Redis keys with 600s payload TTL and 60s cooldown', async () => {
      const result = await service.register(mockRegisterDto);

      expect(result).toEqual({
        message: 'Código de verificación enviado al correo electrónico',
        email: 'eco.user@livora.io',
      });

      // 1. Verify auth:register:payload:${email} stored with 1800s TTL
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:register:payload:eco.user@livora.io',
        JSON.stringify(mockRegisterDto),
        1800,
      );

      // 2. Verify auth:otp:code:${email} stored with 600s TTL (bcrypt hash)
      const codeCall = mockRedisService.set.mock.calls.find(
        (call: any[]) => call[0] === 'auth:otp:code:eco.user@livora.io',
      );
      expect(codeCall).toBeDefined();
      expect(codeCall[2]).toBe(600);
      expect(typeof codeCall[1]).toBe('string');

      // 3. Verify auth:otp:attempts:${email} reset
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );

      // 4. Verify auth:otp:cooldown:${email} stored with 60s TTL
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:otp:cooldown:eco.user@livora.io',
        '1',
        60,
      );

      // 5. Verify email sent with 6-digit OTP
      expect(mockMailService.sendOtpEmail).toHaveBeenCalledWith(
        'eco.user@livora.io',
        expect.stringMatching(/^\d{6}$/),
      );
    });
  });

  describe('resendOtp', () => {
    it('should reject with BadRequestException when 60-second cooldown is active', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:otp:cooldown:eco.user@livora.io') return '1';
        return null;
      });

      await expect(
        service.resendOtp({ email: 'eco.user@livora.io' }),
      ).rejects.toThrow(
        new BadRequestException(
          'Debes esperar 60 segundos antes de reenviar otro código',
        ),
      );

      expect(mockMailService.sendOtpEmail).not.toHaveBeenCalled();
    });

    it('should reject with BadRequestException when payload is expired or missing', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockRedisService.ttl.mockResolvedValue(-2);

      await expect(
        service.resendOtp({ email: 'eco.user@livora.io' }),
      ).rejects.toThrow(
        new BadRequestException(
          'El registro temporal no existe o ha expirado. Por favor regístrate de nuevo.',
        ),
      );
    });

    it('should reject with BadRequestException when payload TTL is 0 or negative', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        return null;
      });
      mockRedisService.ttl.mockResolvedValue(0);

      await expect(
        service.resendOtp({ email: 'eco.user@livora.io' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should clamp new OTP TTL to remaining payload TTL and NEVER reset the 600s payload TTL', async () => {
      const remainingPayloadTtl = 385; // 385 seconds left on the immutable 10m session

      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:otp:cooldown:eco.user@livora.io') return null; // No cooldown active
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        return null;
      });
      mockRedisService.ttl.mockResolvedValue(remainingPayloadTtl);

      const result = await service.resendOtp({ email: 'eco.user@livora.io' });

      expect(result).toEqual({
        message: 'Código de verificación reenviado exitosamente',
        email: 'eco.user@livora.io',
      });

      // Crucial verification: auth:register:payload MUST NOT be called in set()
      const payloadSetCalls = mockRedisService.set.mock.calls.filter(
        (call: any[]) => call[0] === 'auth:register:payload:eco.user@livora.io',
      );
      expect(payloadSetCalls.length).toBe(0);

      // Verify auth:otp:code is updated with EXACT remaining TTL (385s)
      const codeCall = mockRedisService.set.mock.calls.find(
        (call: any[]) => call[0] === 'auth:otp:code:eco.user@livora.io',
      );
      expect(codeCall).toBeDefined();
      expect(codeCall[2]).toBe(remainingPayloadTtl);

      // Verify attempts reset and cooldown set to 60s
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
      expect(mockRedisService.set).toHaveBeenCalledWith(
        'auth:otp:cooldown:eco.user@livora.io',
        '1',
        60,
      );

      // Verify new email sent
      expect(mockMailService.sendOtpEmail).toHaveBeenCalledWith(
        'eco.user@livora.io',
        expect.stringMatching(/^\d{6}$/),
      );
    });
  });

  describe('verifyEmail / verifyOtp', () => {
    it('should throw BadRequestException if payload key is missing / expired', async () => {
      mockRedisService.get.mockResolvedValue(null);

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: '123456' }),
      ).rejects.toThrow(
        new BadRequestException('El código OTP ha expirado o no existe'),
      );
    });

    it('should throw BadRequestException if code key is missing / expired', async () => {
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        return null;
      });

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: '123456' }),
      ).rejects.toThrow(
        new BadRequestException('El código OTP ha expirado o no existe'),
      );
    });

    it('should block verification when attempts >= 5', async () => {
      const hashedCode = await bcrypt.hash('123456', 10);
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return hashedCode;
        }
        if (key === 'auth:otp:attempts:eco.user@livora.io') {
          return '5';
        }
        return null;
      });

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: '123456' }),
      ).rejects.toThrow(
        new BadRequestException(
          'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
        ),
      );
    });

    it('should increment attempts and set TTL on incorrect OTP code', async () => {
      const correctHashedCode = await bcrypt.hash('654321', 10);
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return correctHashedCode;
        }
        if (key === 'auth:otp:attempts:eco.user@livora.io') {
          return '2';
        }
        return null;
      });
      mockRedisService.incr.mockResolvedValue(3);
      mockRedisService.ttl.mockResolvedValue(400);

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: '000000' }),
      ).rejects.toThrow(
        new BadRequestException('El código de verificación es incorrecto'),
      );

      expect(mockRedisService.incr).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
      expect(mockRedisService.expire).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
        400,
      );
    });

    it('should delete OTP code and block on 5th failed attempt', async () => {
      const correctHashedCode = await bcrypt.hash('654321', 10);
      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return correctHashedCode;
        }
        if (key === 'auth:otp:attempts:eco.user@livora.io') {
          return '4';
        }
        return null;
      });
      mockRedisService.incr.mockResolvedValue(5);
      mockRedisService.ttl.mockResolvedValue(350);

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: '000000' }),
      ).rejects.toThrow(
        new BadRequestException(
          'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
        ),
      );

      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:code:eco.user@livora.io',
      );
    });

    it('should succeed, create users, sign in, and clean up all 4 Redis keys on valid OTP', async () => {
      const plainCode = '789123';
      const hashedCode = await bcrypt.hash(plainCode, 10);

      mockRedisService.get.mockImplementation(async (key: string) => {
        if (key === 'auth:register:payload:eco.user@livora.io') {
          return JSON.stringify(mockRegisterDto);
        }
        if (key === 'auth:otp:code:eco.user@livora.io') {
          return hashedCode;
        }
        if (key === 'auth:otp:attempts:eco.user@livora.io') {
          return '1';
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
          id: 'supabase-user-uuid-123',
          email: 'eco.user@livora.io',
          role: Role.HOGAR,
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        },
      });

      // Verify Supabase, Postgres creations, and ConsentAudit recording
      expect(mockSupabaseClient.auth.admin.createUser).toHaveBeenCalledWith({
        email: mockRegisterDto.email,
        password: mockRegisterDto.password,
        email_confirm: true,
      });
      expect(mockUsersService.create).toHaveBeenCalledWith(
        'supabase-user-uuid-123',
        mockRegisterDto,
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

      // Verify cleanup of all 4 decoupled Redis keys
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:register:payload:eco.user@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:code:eco.user@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:attempts:eco.user@livora.io',
      );
      expect(mockRedisService.del).toHaveBeenCalledWith(
        'auth:otp:cooldown:eco.user@livora.io',
      );
    });

    it('should support verifyOtp alias identically', async () => {
      const plainCode = '789123';
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

      const result = await service.verifyOtp({
        email: 'eco.user@livora.io',
        code: plainCode,
      });

      expect(result.accessToken).toBe('jwt-access-token-xyz');
    });

    it('should rollback Supabase user if Postgres creation fails', async () => {
      const plainCode = '789123';
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

      mockUsersService.create.mockRejectedValue(
        new Error('PostgreSQL database constraint error'),
      );

      await expect(
        service.verifyEmail({ email: 'eco.user@livora.io', code: plainCode }),
      ).rejects.toThrow('PostgreSQL database constraint error');

      expect(mockSupabaseClient.auth.admin.deleteUser).toHaveBeenCalledWith(
        'supabase-user-uuid-123',
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
          id: 'supabase-user-uuid-123',
          email: 'eco.user@livora.io',
          role: Role.HOGAR,
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
        },
      });
    });

    it('should throw UnauthorizedException on invalid credentials', async () => {
      mockSupabaseClient.auth.signInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { message: 'Invalid login credentials' },
      });

      await expect(
        service.login({
          email: 'eco.user@livora.io',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('forgotPassword', () => {
    it('should throw BadRequestException if user is not found in database', async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.forgotPassword({ email: 'unknown@livora.io' }),
      ).rejects.toThrow(
        new BadRequestException('El correo electrónico no se encuentra registrado'),
      );
    });

    it('should generate a token, save in Redis for 1h, and send email', async () => {
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'user-uuid-123',
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
        expect.stringContaining('restablecer-contrasena?token='),
      );
    });
  });

  describe('resetPassword', () => {
    it('should throw BadRequestException if token is not found in Redis', async () => {
      mockRedisService.get.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'invalid-token', password: 'NewPassword123!' }),
      ).rejects.toThrow(
        new BadRequestException('El enlace de recuperación es inválido o ha expirado'),
      );
    });

    it('should throw BadRequestException if token is valid but user is not in database', async () => {
      mockRedisService.get.mockResolvedValue('eco.user@livora.io');
      mockUsersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'valid-token', password: 'NewPassword123!' }),
      ).rejects.toThrow(
        new BadRequestException('No se pudo encontrar el usuario asociado a este token'),
      );
    });

    it('should update password in Supabase, and delete token from Redis', async () => {
      mockRedisService.get.mockResolvedValue('eco.user@livora.io');
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'supabase-user-uuid-123',
        email: 'eco.user@livora.io',
      });
      mockSupabaseClient.auth.admin.updateUserById.mockResolvedValue({
        data: { user: {} },
        error: null,
      });

      const result = await service.resetPassword({
        token: 'valid-token',
        password: 'NewPassword123!',
      });

      expect(result).toEqual({
        message: 'Contraseña restablecida exitosamente',
      });

      expect(mockSupabaseClient.auth.admin.updateUserById).toHaveBeenCalledWith(
        'supabase-user-uuid-123',
        { password: 'NewPassword123!' },
      );

      expect(mockRedisService.del).toHaveBeenCalledWith('auth:password-reset:token:valid-token');
    });

    it('should throw BadRequestException if Supabase password update fails', async () => {
      mockRedisService.get.mockResolvedValue('eco.user@livora.io');
      mockUsersService.findByEmail.mockResolvedValue({
        id: 'supabase-user-uuid-123',
        email: 'eco.user@livora.io',
      });
      mockSupabaseClient.auth.admin.updateUserById.mockResolvedValue({
        data: null,
        error: { message: 'Password validation failed' },
      });

      await expect(
        service.resetPassword({
          token: 'valid-token',
          password: 'NewPassword123!',
        }),
      ).rejects.toThrow(
        new BadRequestException('Password validation failed'),
      );
    });
  });
});
