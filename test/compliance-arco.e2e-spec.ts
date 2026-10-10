import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { CurrentUser } from '../src/common/decorators/current-user.decorator';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { PasswordService } from '../src/auth/services/password.service';
import { TokenService } from '../src/auth/services/token.service';
import { SessionService } from '../src/auth/services/session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service';
import { MailService } from '../src/common/services/mail.service';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { VerifyEmailDto } from '../src/auth/dto/verify-email.dto';
import { Role } from '@prisma/client';

let lastSentEmail = '';
let lastSentOtp = '';

@Controller('compliance-test')
class TestComplianceController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('auth/register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('auth/verify')
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    return this.authService.verifyEmail(verifyEmailDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  getProfile(@CurrentUser() user: any) {
    return { success: true, user };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('arco/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelMyAccount(@CurrentUser('id') userId: string) {
    return this.usersService.cancelAccountARCO(userId);
  }
}

@Module({
  controllers: [TestComplianceController],
  providers: [
    AuthService,
    UsersService,
    PasswordService,
    TokenService,
    SessionService,
    JwtAuthGuard,
    {
      provide: PrismaService,
      useFactory: () => {
        // In-memory mock database state
        const users = new Map<string, any>();
        const consentAudits: any[] = [];
        const storeProfiles = new Map<string, any>();
        const kycApplications = new Map<string, any>();
        const complaints = new Map<string, any>();
        const notifications: any[] = [];
        const betaSignups: any[] = [];

        const mockPrisma: any = {
          user: {
            findUnique: jest.fn(
              async ({ where }: { where: { id?: string; email?: string } }) => {
                if (where.id) return users.get(where.id) || null;
                if (where.email) {
                  for (const u of users.values()) {
                    if (u.email === where.email) return u;
                  }
                }
                return null;
              },
            ),
            create: jest.fn(async ({ data }: any) => {
              const record = {
                ...data,
                isActive: true,
                deletedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              users.set(record.id, record);
              return record;
            }),
            update: jest.fn(async ({ where, data }: any) => {
              const existing = users.get(where.id);
              if (!existing) throw new Error('User not found');
              const updated = { ...existing, ...data, updatedAt: new Date() };
              users.set(where.id, updated);
              return updated;
            }),
          },
          consentAudit: {
            create: jest.fn(async ({ data }: any) => {
              const audit = {
                id: `audit-${consentAudits.length + 1}`,
                ...data,
                createdAt: new Date(),
              };
              consentAudits.push(audit);
              return audit;
            }),
            findMany: jest.fn(async ({ where }: any) => {
              return consentAudits.filter((a) => a.userId === where.userId);
            }),
          },
          storeProfile: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, store] of storeProfiles.entries()) {
                if (store.userId === where.userId) {
                  storeProfiles.set(key, { ...store, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          kycApplication: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, kyc] of kycApplications.entries()) {
                if (kyc.userId === where.userId) {
                  kycApplications.set(key, { ...kyc, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          complaint: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, comp] of complaints.entries()) {
                if (comp.userId === where.userId) {
                  complaints.set(key, { ...comp, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          notification: {
            deleteMany: jest.fn(async ({ where }: any) => {
              const initialLen = notifications.length;
              const remaining = notifications.filter(
                (n) => n.userId !== where.userId,
              );
              notifications.length = 0;
              notifications.push(...remaining);
              return { count: initialLen - remaining.length };
            }),
          },
          betaSignup: {
            deleteMany: jest.fn(async ({ where }: any) => {
              const initialLen = betaSignups.length;
              const remaining = betaSignups.filter(
                (b) => b.email !== where.email,
              );
              betaSignups.length = 0;
              betaSignups.push(...remaining);
              return { count: initialLen - remaining.length };
            }),
          },
          walletVault: {
            deleteMany: jest.fn(async () => ({ count: 1 })),
            create: jest.fn(async ({ data }: any) => data),
            findUnique: jest.fn(async () => null),
          },
          userCredential: {
            deleteMany: jest.fn(async () => ({ count: 1 })),
            create: jest.fn(async ({ data }: any) => data),
            findUnique: jest.fn(async () => null),
          },
          $transaction: jest.fn(async (cb) => {
            return cb(mockPrisma);
          }),
        };

        // Expose underlying stores for direct test assertions
        mockPrisma._stores = {
          users,
          consentAudits,
          storeProfiles,
          kycApplications,
          complaints,
          notifications,
          betaSignups,
        };

        return mockPrisma;
      },
    },
    {
      provide: RedisService,
      useFactory: () => {
        const store = new Map<string, string>();
        const sets = new Map<string, Set<string>>();
        const mockClient = {
          get: jest.fn(async (k: string) => store.get(k) || null),
          set: jest.fn(async (k: string, v: string) => {
            store.set(k, v);
            return 'OK';
          }),
          del: jest.fn(async (k: string) => {
            store.delete(k);
            return 1;
          }),
          ttl: jest.fn(async () => 600),
          incr: jest.fn(async () => 1),
          expire: jest.fn(async () => 1),
          sadd: jest.fn(async (k: string, m: string) => {
            if (!sets.has(k)) sets.set(k, new Set());
            sets.get(k)!.add(m);
            return 1;
          }),
          smembers: jest.fn(async (k: string) => Array.from(sets.get(k) || [])),
          srem: jest.fn(async (k: string, m: string) => {
            sets.get(k)?.delete(m);
            return 1;
          }),
        };
        return {
          ...mockClient,
          getClient: () => mockClient,
        };
      },
    },
    {
      provide: MailService,
      useValue: {
        sendOtpEmail: jest.fn(async (email: string, code: string) => {
          lastSentEmail = email;
          lastSentOtp = code;
        }),
      },
    },
    {
      provide: ConfigService,
      useValue: {
        get: jest.fn((k: string) => {
          if (k === 'WALLET_ENCRYPTION_KEY')
            return 'compliance_test_secret_key_32c!';
          if (k === 'JWT_SECRET')
            return 'compliance_jwt_secret_key_livora_2026';
          return null;
        }),
      },
    },
  ],
})
class TestComplianceModule {}

describe('Compliance Data Model & Irreversible ARCO Deletion (E2E Suite)', () => {
  let app: NestFastifyApplication;
  let prismaMock: any;
  let redisMock: any;
  let validJwtToken = '';
  let createdUserId = '';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestComplianceModule],
    }).compile();

    prismaMock = moduleRef.get<PrismaService>(PrismaService);
    redisMock = moduleRef.get<RedisService>(RedisService);

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

  it('1. Register & verify user captures immutable ConsentAudit record matching Ley 29733 requirements', async () => {
    // Step 1: Register
    const registerRes = await request(app.getHttpServer())
      .post('/compliance-test/auth/register')
      .send({
        email: 'arco.citizen@livora.io',
        password: 'SecurePassword123!',
        role: Role.HOGAR,
        termsVersion: '2.1.0',
        privacyVersion: '2.1.0',
        documentHash:
          'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
        ipAddress: '200.48.100.25',
        userAgent: 'LivoraApp/2.1 (Android 14; Mobile)',
      })
      .expect(201);

    expect(registerRes.body.email).toBe('arco.citizen@livora.io');
    expect(lastSentOtp).toMatch(/^\d{6}$/);

    // Step 2: Verify with OTP
    const verifyRes = await request(app.getHttpServer())
      .post('/compliance-test/auth/verify')
      .send({
        email: 'arco.citizen@livora.io',
        code: lastSentOtp,
      })
      .expect(201);

    validJwtToken = verifyRes.body.accessToken;
    createdUserId = verifyRes.body.user.id;
    expect(validJwtToken).toBeDefined();
    expect(verifyRes.body.user.email).toBe('arco.citizen@livora.io');
    expect(verifyRes.body.user.walletAddress).toMatch(/^G[A-Z0-9]{55}$/); // Valid Stellar public key

    // Verify ConsentAudit immutable record in PostgreSQL
    const audits = prismaMock._stores.consentAudits;
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit.userId).toBe(createdUserId);
    expect(audit.ipAddress).toBe('200.48.100.25');
    expect(audit.userAgent).toBe('LivoraApp/2.1 (Android 14; Mobile)');
    expect(audit.termsVersion).toBe('2.1.0');
    expect(audit.privacyVersion).toBe('2.1.0');
    expect(audit.documentHash).toBe(
      'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
    );
    expect(audit.consentedAt).toBeInstanceOf(Date);

    // Verify User record in PostgreSQL has encrypted Web3 key and is active
    const user = prismaMock._stores.users.get(createdUserId);
    expect(user).toBeDefined();
    expect(user.isActive).toBe(true);
    expect(user.deletedAt).toBeNull();
    expect(user.encryptedPrivateKey).toBeDefined();
    expect(user.encryptedPrivateKey.length).toBeGreaterThan(20);
  });

  it('2. Authenticated user can access protected endpoints before ARCO deletion', async () => {
    const res = await request(app.getHttpServer())
      .get('/compliance-test/profile')
      .set('Authorization', `Bearer ${validJwtToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.user.id).toBe(createdUserId);
    expect(res.body.user.email).toBe('arco.citizen@livora.io');
    // Ensure encryptedPrivateKey is stripped from request.user
    expect(res.body.user.encryptedPrivateKey).toBeUndefined();
  });

  it('3. Executing ARCO deletion irreversibly destroys Web3 private key, anonymizes email, sets soft-delete flags, but preserves walletAddress for blockchain integrity', async () => {
    const initialUser = prismaMock._stores.users.get(createdUserId);
    const originalWallet = initialUser.walletAddress;

    const res = await request(app.getHttpServer())
      .delete('/compliance-test/arco/cancel')
      .set('Authorization', `Bearer ${validJwtToken}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Ley 29733');

    // Inspect user record in database
    const modifiedUser = prismaMock._stores.users.get(createdUserId);
    expect(modifiedUser).toBeDefined();

    // 1. Email is anonymized
    expect(modifiedUser.email).toMatch(
      /^deleted_.*@.*livora\.(org|pe)$/,
    );

    // 2. Web3 private key is irreversibly destroyed (null)
    expect(modifiedUser.encryptedPrivateKey).toBeNull();

    // 3. Tokens & PINs cleared
    expect(modifiedUser.fcmToken).toBeNull();
    expect(modifiedUser.receptionPin).toBeNull();

    // 4. Soft-delete timestamp and isActive = false
    expect(modifiedUser.isActive).toBe(false);
    expect(modifiedUser.deletedAt).toBeInstanceOf(Date);

    // 5. Blockchain walletAddress is preserved intact to maintain immutable transaction ledger integrity
    expect(modifiedUser.walletAddress).toBe(originalWallet);
  });

  it('4. Subsequent requests from soft-deleted user are rejected with 401 Unauthorized ("Cuenta desactivada o eliminada")', async () => {
    const res = await request(app.getHttpServer())
      .get('/compliance-test/profile')
      .set('Authorization', `Bearer ${validJwtToken}`)
      .expect(401);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.status).toBe(401);
    expect(res.body.detail).toBe('Cuenta desactivada o eliminada');
  });

  it('5. Repeated ARCO deletion attempt on already deleted user returns 401 (blocked by guard)', async () => {
    const res = await request(app.getHttpServer())
      .delete('/compliance-test/arco/cancel')
      .set('Authorization', `Bearer ${validJwtToken}`)
      .expect(401); // Auth guard blocks before reaching controller

    expect(res.body.detail).toBe('Cuenta desactivada o eliminada');
  });
});
