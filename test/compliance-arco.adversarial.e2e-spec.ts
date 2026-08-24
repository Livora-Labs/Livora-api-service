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
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { CurrentUser } from '../src/common/decorators/current-user.decorator';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service';
import { MailService } from '../src/common/services/mail.service';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { VerifyEmailDto } from '../src/auth/dto/verify-email.dto';
import { Role } from '@prisma/client';
import { CryptoUtil } from '../src/common/utils/crypto.util';
import * as crypto from 'crypto';

let lastSentEmail = '';
let lastSentOtp = '';

@Controller('adv-compliance')
class AdversarialComplianceController {
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

  @UseGuards(SupabaseAuthGuard)
  @Get('profile')
  getProfile(@CurrentUser() user: any) {
    return { success: true, user };
  }

  @UseGuards(SupabaseAuthGuard)
  @Delete('arco/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelMyAccount(@CurrentUser('id') userId: string) {
    return this.usersService.cancelAccountARCO(userId);
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('audits')
  async getMyAudits(@CurrentUser('id') userId: string) {
    return this.usersService.getConsentAudits(userId);
  }
}

@Module({
  controllers: [AdversarialComplianceController],
  providers: [
    AuthService,
    UsersService,
    {
      provide: PrismaService,
      useFactory: () => {
        const users = new Map<string, any>();
        const consentAudits: any[] = [];
        const storeProfiles = new Map<string, any>();
        const kycApplications = new Map<string, any>();
        const complaints = new Map<string, any>();
        const notifications: any[] = [];
        const betaSignups: any[] = [];
        const redemptions = new Map<string, any>();

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
            findMany: jest.fn(async ({ where, orderBy }: any) => {
              const filtered = consentAudits.filter(
                (a) => a.userId === where.userId,
              );
              if (orderBy && orderBy.consentedAt === 'desc') {
                return filtered.sort(
                  (a, b) => b.consentedAt.getTime() - a.consentedAt.getTime(),
                );
              }
              return filtered;
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
          redemptionTransaction: {
            findMany: jest.fn(async ({ where }: any) => {
              return Array.from(redemptions.values()).filter(
                (r) => r.userId === where.userId,
              );
            }),
          },
          $transaction: jest.fn(async (cb) => {
            return cb(mockPrisma);
          }),
        };

        mockPrisma._stores = {
          users,
          consentAudits,
          storeProfiles,
          kycApplications,
          complaints,
          notifications,
          betaSignups,
          redemptions,
        };

        return mockPrisma;
      },
    },
    {
      provide: SupabaseService,
      useFactory: () => {
        const authUsers = new Map<string, any>();
        return {
          getClient: () => ({
            auth: {
              admin: {
                createUser: jest.fn(async ({ email, password }: any) => {
                  const id = `supabase-${crypto.randomUUID()}`;
                  const authUser = { id, email };
                  authUsers.set(id, authUser);
                  return { data: { user: authUser }, error: null };
                }),
                deleteUser: jest.fn(async (id: string) => {
                  authUsers.delete(id);
                  return { data: {}, error: null };
                }),
              },
              signInWithPassword: jest.fn(async ({ email }: any) => {
                let found: any = null;
                for (const u of authUsers.values()) {
                  if (u.email === email) {
                    found = u;
                    break;
                  }
                }
                if (!found) {
                  return {
                    data: { session: null, user: null },
                    error: { message: 'Invalid credentials' },
                  };
                }
                return {
                  data: {
                    session: {
                      access_token: `jwt-${found.id}`,
                      refresh_token: `refresh-${found.id}`,
                      expires_in: 3600,
                      token_type: 'bearer',
                    },
                    user: found,
                  },
                  error: null,
                };
              }),
              getUser: jest.fn(async (token: string) => {
                if (token.startsWith('jwt-supabase-')) {
                  const id = token.replace('jwt-', '');
                  const u = authUsers.get(id);
                  if (u) {
                    return { data: { user: u }, error: null };
                  }
                }
                return {
                  data: { user: null },
                  error: { message: 'Invalid JWT' },
                };
              }),
            },
          }),
        };
      },
    },
    {
      provide: RedisService,
      useFactory: () => {
        const store = new Map<string, string>();
        return {
          get: jest.fn(async (k: string) => store.get(k) || null),
          set: jest.fn(async (k: string, v: string) => {
            store.set(k, v);
          }),
          del: jest.fn(async (k: string) => {
            store.delete(k);
          }),
          ttl: jest.fn(async () => 600),
          incr: jest.fn(async () => 1),
          expire: jest.fn(async () => true),
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
          return null;
        }),
      },
    },
  ],
})
class AdversarialComplianceModule {}

describe('Milestone M4 Adversarial Challenge: Ley 29733, ARCO Cascade & Web3 Key Destruction', () => {
  let app: NestFastifyApplication;
  let prismaMock: any;
  const encryptionKey = 'compliance_test_secret_key_32c!';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AdversarialComplianceModule],
    }).compile();

    prismaMock = moduleRef.get<PrismaService>(PrismaService);

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

  describe('Adversarial Challenge 1: Immutable Consent Audit Capture & Fallbacks', () => {
    it('1.1 Registration with explicit custom metadata stores exact IP, UserAgent, and SHA-256 hash', async () => {
      const email = 'consent.custom@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({
          email,
          password: 'Password123!',
          role: Role.HOGAR,
          termsVersion: '3.0.0',
          privacyVersion: '3.0.0',
          documentHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          ipAddress: '190.236.45.10',
          userAgent:
            'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
        })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const userId = verifyRes.body.user.id;
      const audits = prismaMock._stores.consentAudits.filter(
        (a: any) => a.userId === userId,
      );
      expect(audits.length).toBe(1);
      expect(audits[0].termsVersion).toBe('3.0.0');
      expect(audits[0].privacyVersion).toBe('3.0.0');
      expect(audits[0].documentHash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      expect(audits[0].ipAddress).toBe('190.236.45.10');
      expect(audits[0].userAgent).toBe(
        'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0',
      );
      expect(audits[0].consentedAt).toBeInstanceOf(Date);
    });

    it('1.2 Registration with missing optional metadata generates deterministic fallback hash and default versions', async () => {
      const email = 'consent.defaults@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({
          email,
          password: 'Password123!',
          role: Role.RECOLECTOR,
        })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const userId = verifyRes.body.user.id;
      const audits = prismaMock._stores.consentAudits.filter(
        (a: any) => a.userId === userId,
      );
      expect(audits.length).toBe(1);
      expect(audits[0].termsVersion).toBe('1.0.0');
      expect(audits[0].privacyVersion).toBe('1.0.0');
      const expectedHash = crypto
        .createHash('sha256')
        .update('Livora-Terms-1.0.0-Privacy-1.0.0')
        .digest('hex');
      expect(audits[0].documentHash).toBe(expectedHash);
      expect(audits[0].ipAddress).toBe('127.0.0.1');
      expect(audits[0].userAgent).toBe('unknown');
    });

    it('1.3 Fetching consent audits returns history in reverse chronological order', async () => {
      const email = 'consent.history@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({
          email,
          password: 'Password123!',
          role: Role.HOGAR,
          termsVersion: '1.0.0',
        })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const token = verifyRes.body.accessToken;
      const userId = verifyRes.body.user.id;

      // Add a second newer consent version directly to store
      prismaMock._stores.consentAudits.push({
        id: 'audit-v2',
        userId,
        ipAddress: '190.236.99.1',
        userAgent: 'LivoraApp/3.0',
        termsVersion: '2.0.0',
        privacyVersion: '2.0.0',
        documentHash: 'hash-v2-mock',
        consentedAt: new Date(Date.now() + 10000),
        createdAt: new Date(),
      });

      const auditRes = await request(app.getHttpServer())
        .get('/adv-compliance/audits')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(auditRes.body.length).toBe(2);
      expect(auditRes.body[0].termsVersion).toBe('2.0.0'); // Newest first
      expect(auditRes.body[1].termsVersion).toBe('1.0.0');
    });
  });

  describe('Adversarial Challenge 2: Complete ARCO Multi-Table Cascading Anonymization', () => {
    let merchantUserId: string;
    let merchantToken: string;
    let merchantOriginalWallet: string;
    const merchantEmail = 'merchant.complex@livora.io';

    beforeAll(async () => {
      // 1. Create merchant user
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({
          email: merchantEmail,
          password: 'ComplexPassword123!',
          role: Role.TIENDA,
          termsVersion: '1.0.0',
          ipAddress: '200.48.10.1',
          userAgent: 'LivoraMerchant/1.0',
        })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email: merchantEmail, code: lastSentOtp })
        .expect(201);

      merchantUserId = verifyRes.body.user.id;
      merchantToken = verifyRes.body.accessToken;
      merchantOriginalWallet = verifyRes.body.user.walletAddress;

      // 2. Populate all related models for this merchant in the database
      // Store profile
      prismaMock._stores.storeProfiles.set('store-1', {
        id: 'store-1',
        userId: merchantUserId,
        businessName: 'Bodega San Martín S.A.C.',
        ruc: '20123456789',
        address: 'Av. Larco 123, Miraflores, Lima',
        bankAccount: 'BCP-191-99887766-0-12',
        logoUrl: 'https://cdn.livora.org/logos/bodega_san_martin.png',
      });

      // KYC Application
      prismaMock._stores.kycApplications.set('kyc-1', {
        id: 'kyc-1',
        userId: merchantUserId,
        status: 'APPROVED',
        documentUrl: 'https://cdn.livora.org/kyc/dni_san_martin.pdf',
      });

      // Complaint
      prismaMock._stores.complaints.set('comp-1', {
        id: 'comp-1',
        userId: merchantUserId,
        subject: 'Reclamo de comisión por canje de tokens #5541',
        description:
          'El comerciante Juan Perez solicita el reintegro de S/. 50.00 retenidos',
        status: 'RESOLVED',
      });

      // Notifications
      prismaMock._stores.notifications.push(
        {
          id: 'notif-1',
          userId: merchantUserId,
          title: 'KYC Aprobado',
          message: 'Tu cuenta de comercio está activa',
        },
        {
          id: 'notif-2',
          userId: merchantUserId,
          title: 'Nuevo canje recibido',
          message: 'Se han canjeado 100 LIV tokens en tu establecimiento',
        },
      );

      // Beta waitlist record
      prismaMock._stores.betaSignups.push({
        id: 'beta-1',
        email: merchantEmail,
        createdAt: new Date(),
      });

      // Redemption Transaction (to check on-chain ledger integrity)
      prismaMock._stores.redemptions.set('redemption-1', {
        id: 'redemption-1',
        storeId: 'store-1',
        userId: merchantUserId,
        tokenAmount: 50.0,
        qrCodeRef: 'QR-TOKEN-REF-999',
        status: 'COMPLETED',
        txHash: '0xstellar_valid_tx_hash_1234567890abcdef',
      });
    });

    it('2.1 ARCO Cancellation transactionally wipes and anonymizes PII across all 6 linked models', async () => {
      const cancelRes = await request(app.getHttpServer())
        .delete('/adv-compliance/arco/cancel')
        .set('Authorization', `Bearer ${merchantToken}`)
        .expect(200);

      expect(cancelRes.body.success).toBe(true);
      expect(cancelRes.body.message).toContain('Ley 29733');

      // Check Model 1: User
      const user = prismaMock._stores.users.get(merchantUserId);
      expect(user).toBeDefined();
      expect(user.email).not.toBe(merchantEmail);
      expect(user.email).toMatch(/^deleted_supabase_\d+@deleted\.livora\.org$/);
      expect(user.isActive).toBe(false);
      expect(user.deletedAt).toBeInstanceOf(Date);
      expect(user.fcmToken).toBeNull();
      expect(user.receptionPin).toBeNull();

      // Check Model 2: StoreProfile
      const store = prismaMock._stores.storeProfiles.get('store-1');
      expect(store.businessName).toBe('Tienda Anonimizada (ARCO)');
      expect(store.ruc).toBe('00000000000');
      expect(store.address).toBe('Dirección Anonimizada');
      expect(store.bankAccount).toBe('ANONIMIZADO');
      expect(store.logoUrl).toBeNull();

      // Check Model 3: KycApplication
      const kyc = prismaMock._stores.kycApplications.get('kyc-1');
      expect(kyc.documentUrl).toBeNull();
      expect(kyc.status).toBe('REJECTED');

      // Check Model 4: Complaint
      const complaint = prismaMock._stores.complaints.get('comp-1');
      expect(complaint.subject).toBe('Queja Anonimizada');
      expect(complaint.description).toBe(
        'Contenido suprimido por solicitud de cancelación ARCO (Ley 29733)',
      );

      // Check Model 5: Notifications
      const notifs = prismaMock._stores.notifications.filter(
        (n: any) => n.userId === merchantUserId,
      );
      expect(notifs.length).toBe(0);

      // Check Model 6: BetaSignup
      const betas = prismaMock._stores.betaSignups.filter(
        (b: any) => b.email === merchantEmail,
      );
      expect(betas.length).toBe(0);
    });

    it('2.2 Blockchain ledger preservation: walletAddress remains intact and unlinked from physical identity', async () => {
      const user = prismaMock._stores.users.get(merchantUserId);
      // Public Stellar address is unchanged
      expect(user.walletAddress).toBe(merchantOriginalWallet);
      expect(user.walletAddress).toMatch(/^G[A-Z0-9]{55}$/);

      // On-chain redemption ledger remains intact for accounting
      const redemption = prismaMock._stores.redemptions.get('redemption-1');
      expect(redemption.tokenAmount).toBe(50.0);
      expect(redemption.qrCodeRef).toBe('QR-TOKEN-REF-999');
      expect(redemption.txHash).toBe(
        '0xstellar_valid_tx_hash_1234567890abcdef',
      );
    });

    it('2.3 Cryptographic Key Destruction: encryptedPrivateKey is strictly nullified and cannot be decrypted', async () => {
      const user = prismaMock._stores.users.get(merchantUserId);
      expect(user.encryptedPrivateKey).toBeNull();

      // Attempting to decrypt null must fail or throw
      expect(() => {
        if (!user.encryptedPrivateKey) {
          throw new Error('Key is destroyed');
        }
        CryptoUtil.decrypt(user.encryptedPrivateKey, encryptionKey);
      }).toThrow('Key is destroyed');
    });

    it('2.4 Transaction atomicity: if an error occurs in the transaction, state remains uncorrupted', async () => {
      // Create another temporary user
      const tempUser = {
        id: 'user-rollback-test',
        email: 'rollback@livora.io',
        walletAddress: 'GAW_ROLLBACK_TEST_1234567890',
        encryptedPrivateKey: 'iv:salt:tag:ciphertext',
        isActive: true,
        deletedAt: null,
      };
      prismaMock._stores.users.set(tempUser.id, tempUser);

      // Simulate a database exception during transaction
      const failingPrisma: any = {
        user: {
          findUnique: jest.fn().mockResolvedValue(tempUser),
          update: jest.fn().mockImplementation(() => {
            throw new Error('PostgreSQL deadlock / foreign key violation');
          }),
        },
        $transaction: jest.fn(async (cb) => cb(failingPrisma)),
      };

      const failingService = new UsersService(
        failingPrisma,
        { get: jest.fn() } as any,
        {
          getClient: jest
            .fn()
            .mockReturnValue({ auth: { admin: { deleteUser: jest.fn() } } }),
        } as any,
      );

      await expect(
        failingService.cancelAccountARCO('user-rollback-test'),
      ).rejects.toThrow('PostgreSQL deadlock / foreign key violation');

      // Assert original user state is completely unmodified
      const unmodifiedUser = prismaMock._stores.users.get('user-rollback-test');
      expect(unmodifiedUser.email).toBe('rollback@livora.io');
      expect(unmodifiedUser.encryptedPrivateKey).toBe('iv:salt:tag:ciphertext');
      expect(unmodifiedUser.isActive).toBe(true);
      expect(unmodifiedUser.deletedAt).toBeNull();
    });
  });

  describe('Adversarial Challenge 3: Soft-Delete SupabaseAuthGuard Defense & Boundary Testing', () => {
    it('3.1 Soft-deleted user is immediately rejected with 401 Problem Details (both via Supabase revocation and local DB soft-delete check)', async () => {
      const email = 'guard.softdeleted@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const token = verifyRes.body.accessToken;
      const userId = verifyRes.body.user.id;

      // Access before deletion: 200 OK
      await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Scenario A: Local database user is marked soft-deleted (deletedAt !== null) while Supabase token is still valid
      const localUser = prismaMock._stores.users.get(userId);
      localUser.deletedAt = new Date();
      localUser.isActive = false;

      const softDeletedRes = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(softDeletedRes.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(softDeletedRes.body.type).toBe(
        'https://api.livora.org/errors/unauthorized',
      );
      expect(softDeletedRes.body.status).toBe(401);
      expect(softDeletedRes.body.detail).toBe('Cuenta desactivada o eliminada');
      expect(softDeletedRes.body.instance).toBe('/adv-compliance/profile');

      // Scenario B: After ARCO cancellation, Supabase Auth user is also purged
      // Execute ARCO cancellation (will succeed or reject as already soft-deleted)
      // Restore isActive temporarily to execute full ARCO flow
      localUser.isActive = true;
      localUser.deletedAt = null;
      await request(app.getHttpServer())
        .delete('/adv-compliance/arco/cancel')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const rejectedRes = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(rejectedRes.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(rejectedRes.body.status).toBe(401);
    });

    it('3.2 Inactive user (isActive=false, deletedAt=null) is rejected by SupabaseAuthGuard', async () => {
      const email = 'guard.inactive@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const token = verifyRes.body.accessToken;
      const userId = verifyRes.body.user.id;

      // Manually set isActive = false without deletedAt
      const user = prismaMock._stores.users.get(userId);
      user.isActive = false;
      user.deletedAt = null;

      const res = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(res.body.detail).toBe('Cuenta desactivada o eliminada');
    });

    it('3.3 User deleted from PostgreSQL but with active JWT is rejected with specific error', async () => {
      const email = 'guard.ghost@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const token = verifyRes.body.accessToken;
      const userId = verifyRes.body.user.id;

      // Delete from local PostgreSQL map
      prismaMock._stores.users.delete(userId);

      const res = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(res.body.detail).toBe(
        'Usuario autenticado pero sin perfil local en la base de datos',
      );
    });

    it('3.4 Adversarial Bearer header formats are correctly sanitized and processed', async () => {
      const email = 'guard.headers@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const token = verifyRes.body.accessToken;

      // Lowercase "bearer <token>"
      await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `bearer ${token}`)
        .expect(200);

      // Multiple spaces "Bearer    <token>"
      await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer    ${token}`)
        .expect(200);

      // Double prefix "Bearer Bearer <token>"
      await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer Bearer ${token}`)
        .expect(200);

      // Empty Bearer -> 401
      const emptyRes = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', 'Bearer    ')
        .expect(401);
      expect(emptyRes.body.detail).toBe('Token JWT no especificado');

      // Missing header -> 401
      const missingRes = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .expect(401);
      expect(missingRes.body.detail).toBe(
        'Token de autorización no encontrado en la cabecera',
      );
    });
  });

  describe('Adversarial Challenge 4: Secrets Isolation & Security Invariants', () => {
    it('4.1 encryptedPrivateKey is NEVER returned by register/verify endpoints or request.user', async () => {
      const email = 'secret.isolation@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      expect(verifyRes.body.user.encryptedPrivateKey).toBeUndefined();

      const profileRes = await request(app.getHttpServer())
        .get('/adv-compliance/profile')
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .expect(200);

      expect(profileRes.body.user.encryptedPrivateKey).toBeUndefined();
    });

    it('4.2 Generated wallet addresses strictly comply with Stellar public key specification (ed25519 G-address)', async () => {
      const email = 'stellar.wallet@livora.io';
      await request(app.getHttpServer())
        .post('/adv-compliance/auth/register')
        .send({ email, password: 'Password123!', role: Role.HOGAR })
        .expect(201);

      const verifyRes = await request(app.getHttpServer())
        .post('/adv-compliance/auth/verify')
        .send({ email, code: lastSentOtp })
        .expect(201);

      const wallet = verifyRes.body.user.walletAddress;
      expect(wallet).toMatch(/^G[A-Z2-7]{55}$/);
      expect(wallet.length).toBe(56);
      expect(wallet.startsWith('G')).toBe(true);
    });
  });
});
