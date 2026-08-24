import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ComplaintsService, ComplaintPdfData } from '../src/complaints/complaints.service';
import { CreateComplaintDto } from '../src/complaints/dto/create-complaint.dto';
import { UsersService } from '../src/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/services/mail.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../src/supabase/supabase.service';
import { CryptoUtil } from '../src/common/utils/crypto.util';
import * as fs from 'fs';
import * as path from 'path';

describe('Adversarial Stress & Edge Case Harness (Challenger 1)', () => {
  let complaintsService: ComplaintsService;
  let usersService: UsersService;
  let mockPrismaService: any;
  let mockMailService: any;
  let mockSupabaseService: any;
  let mockConfigService: any;

  // In-memory mock database state
  let dbComplaints: any[] = [];
  let dbUsers: Map<string, any> = new Map();
  let dbStoreProfiles: Map<string, any> = new Map();
  let dbKycApplications: Map<string, any> = new Map();
  let dbNotifications: any[] = [];
  let dbBetaSignups: any[] = [];

  beforeEach(async () => {
    dbComplaints = [];
    dbUsers = new Map();
    dbStoreProfiles = new Map();
    dbKycApplications = new Map();
    dbNotifications = [];
    dbBetaSignups = [];

    mockPrismaService = {
      complaint: {
        findMany: jest.fn(async (query: any) => {
          let results = [...dbComplaints];
          if (query?.where?.correlativeNumber) {
            const { startsWith, endsWith } = query.where.correlativeNumber;
            if (startsWith) {
              results = results.filter((c) =>
                c.correlativeNumber.startsWith(startsWith),
              );
            }
            if (endsWith) {
              results = results.filter((c) =>
                c.correlativeNumber.endsWith(endsWith),
              );
            }
          }
          return results.map((c) => ({ correlativeNumber: c.correlativeNumber }));
        }),
        create: jest.fn(async ({ data }: any) => {
          const record = {
            id: `complaint-${Date.now()}-${Math.random()}`,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbComplaints.push(record);
          return record;
        }),
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.id) {
            return dbComplaints.find((c) => c.id === where.id) || null;
          }
          if (where.correlativeNumber) {
            return (
              dbComplaints.find(
                (c) => c.correlativeNumber === where.correlativeNumber,
              ) || null
            );
          }
          return null;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const c of dbComplaints) {
            if (c.userId === where.userId) {
              Object.assign(c, data);
              count++;
            }
          }
          return { count };
        }),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.id) return dbUsers.get(where.id) || null;
          if (where.email) {
            for (const u of dbUsers.values()) {
              if (u.email === where.email) return u;
            }
          }
          return null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const user = {
            ...data,
            isActive: true,
            deletedAt: null,
            fcmToken: 'fcm-token-123',
            receptionPin: '1234',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbUsers.set(user.id, user);
          return user;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const user = dbUsers.get(where.id);
          if (!user) throw new Error('User not found in update');
          Object.assign(user, data);
          return user;
        }),
      },
      storeProfile: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const sp of dbStoreProfiles.values()) {
            if (sp.userId === where.userId) {
              Object.assign(sp, data);
              count++;
            }
          }
          return { count };
        }),
      },
      kycApplication: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const kyc of dbKycApplications.values()) {
            if (kyc.userId === where.userId) {
              Object.assign(kyc, data);
              count++;
            }
          }
          return { count };
        }),
      },
      notification: {
        deleteMany: jest.fn(async ({ where }: any) => {
          const initialLen = dbNotifications.length;
          dbNotifications = dbNotifications.filter((n) => n.userId !== where.userId);
          return { count: initialLen - dbNotifications.length };
        }),
      },
      betaSignup: {
        deleteMany: jest.fn(async ({ where }: any) => {
          const initialLen = dbBetaSignups.length;
          dbBetaSignups = dbBetaSignups.filter((b) => b.email !== where.email);
          return { count: initialLen - dbBetaSignups.length };
        }),
      },
      $transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
        return cb(mockPrismaService);
      }),
    };

    mockMailService = {
      sendComplaintConfirmationEmail: jest.fn().mockResolvedValue(undefined),
      sendOtpEmail: jest.fn().mockResolvedValue(undefined),
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue({
        auth: {
          admin: {
            deleteUser: jest.fn().mockResolvedValue({ error: null }),
          },
        },
      }),
    };

    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'WALLET_ENCRYPTION_KEY') return 'test_wallet_aes256_secret_key_32b';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplaintsService,
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: MailService, useValue: mockMailService },
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    complaintsService = module.get<ComplaintsService>(ComplaintsService);
    usersService = module.get<UsersService>(UsersService);
  });

  // =========================================================================
  // 1. CORRELATIVE ROLLOVER ACROSS YEARS & HIGH SEQUENCE PADDING
  // =========================================================================
  describe('1. Correlative Rollover Across Years & High Sequence Padding', () => {
    it('should reset sequence to 00001 when advancing from year 2026 to 2027', async () => {
      // Setup existing records in 2026 with high sequence
      dbComplaints.push(
        { correlativeNumber: 'R-00001-2026' },
        { correlativeNumber: 'R-00050-2026' },
        { correlativeNumber: 'R-09999-2026' },
        { correlativeNumber: 'Q-00012-2026' },
      );

      // In 2026: next reclamo is R-10000-2026
      const next2026 = await complaintsService.generateCorrelativeNumber('RECLAMO');
      expect(next2026).toBe(`R-10000-${new Date().getFullYear()}`);

      // Simulate calendar year advancing to 2027 by mocking Date
      const realDate = global.Date;
      const mock2027 = new Date('2027-01-01T12:00:00.000Z');
      (global as any).Date = class extends realDate {
        constructor(...args: any[]) {
          if (args.length) {
            super(...(args as [any]));
          } else {
            return new realDate(mock2027.getTime());
          }
        }
        static now() {
          return mock2027.getTime();
        }
      };

      try {
        const next2027Reclamo = await complaintsService.generateCorrelativeNumber('RECLAMO');
        expect(next2027Reclamo).toBe('R-00001-2027');

        const next2027Queja = await complaintsService.generateCorrelativeNumber('QUEJA');
        expect(next2027Queja).toBe('Q-00001-2027');
      } finally {
        global.Date = realDate;
      }
    });

    it('should maintain strict isolation between RECLAMO and QUEJA prefixes within the same year', async () => {
      dbComplaints.push(
        { correlativeNumber: 'R-00001-2026' },
        { correlativeNumber: 'R-00002-2026' },
        { correlativeNumber: 'R-00003-2026' },
      );

      const nextReclamo = await complaintsService.generateCorrelativeNumber('RECLAMO');
      const nextQueja = await complaintsService.generateCorrelativeNumber('QUEJA');

      const year = new Date().getFullYear();
      expect(nextReclamo).toBe(`R-00004-${year}`);
      expect(nextQueja).toBe(`Q-00001-${year}`);
    });

    it('should format 5-digit padding accurately up to 99999 and expand past 100000 without crashing', async () => {
      const year = new Date().getFullYear();
      dbComplaints.push({ correlativeNumber: `R-99999-${year}` });

      const nextOverLimit = await complaintsService.generateCorrelativeNumber('RECLAMO');
      expect(nextOverLimit).toBe(`R-100000-${year}`);
    });
  });

  // =========================================================================
  // 2. HIGH-THROUGHPUT & CONCURRENCY CORRELATIVE GENERATION
  // =========================================================================
  describe('2. High-Throughput & Concurrency Stress Test', () => {
    it('should generate 100 sequential unique correlatives without duplicates', async () => {
      const totalRequests = 100;
      const year = new Date().getFullYear();
      const generatedCorrelatives: string[] = [];

      for (let i = 0; i < totalRequests; i++) {
        const claimType = i % 2 === 0 ? 'RECLAMO' : 'QUEJA';
        const num = await complaintsService.generateCorrelativeNumber(claimType);
        generatedCorrelatives.push(num);
        dbComplaints.push({ correlativeNumber: num });
      }

      expect(generatedCorrelatives.length).toBe(totalRequests);

      // Check uniqueness
      const uniqueSet = new Set(generatedCorrelatives);
      expect(uniqueSet.size).toBe(totalRequests);

      // Verify all match pattern
      for (const num of generatedCorrelatives) {
        expect(num).toMatch(/^(R|Q)-\d{5,}-\d{4}$/);
      }

      // Check first and last numbers for RECLAMO and QUEJA
      const reclamos = generatedCorrelatives.filter((c) => c.startsWith('R-'));
      const quejas = generatedCorrelatives.filter((c) => c.startsWith('Q-'));

      expect(reclamos.length).toBe(50);
      expect(quejas.length).toBe(50);
      expect(reclamos[0]).toBe(`R-00001-${year}`);
      expect(reclamos[49]).toBe(`R-00050-${year}`);
      expect(quejas[0]).toBe(`Q-00001-${year}`);
      expect(quejas[49]).toBe(`Q-00050-${year}`);
    });
  });

  // =========================================================================
  // 3. INVALID DOCUMENT FORMATS & DTO VALIDATION FUZZING
  // =========================================================================
  describe('3. Invalid Document Formats & DTO Validation Fuzzing', () => {
    const validBasePayload = {
      documentType: 'DNI',
      documentNumber: '72345678',
      fullName: 'Juan Perez',
      address: 'Av. Arequipa 123, Miraflores',
      phone: '987654321',
      email: 'juan.perez@example.com',
      isMinor: false,
      goodType: 'PRODUCTO',
      goodDescription: 'Reciclaje de botellas PET 500ml',
      amount: 15.5,
      claimType: 'RECLAMO',
      claimDetail: 'No se me abonaron los tokens correspondientes al pesaje',
      consumerRequest: 'Abono inmediato de 25 ECO tokens',
    };

    it('should validate valid DTO successfully with 0 validation errors', async () => {
      const dto = plainToInstance(CreateComplaintDto, validBasePayload);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject invalid documentType values', async () => {
      const invalidTypes = ['PASSPORT', 'CEDULA', 'LIBRETA', '123', ''];
      for (const dt of invalidTypes) {
        const dto = plainToInstance(CreateComplaintDto, {
          ...validBasePayload,
          documentType: dt,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const docTypeError = errors.find((e) => e.property === 'documentType');
        expect(docTypeError).toBeDefined();
      }
    });

    it('should reject invalid email formats', async () => {
      const invalidEmails = [
        'plainaddress',
        '@missingusername.com',
        'username@.com',
        'username@domain..com',
        'spaces in@domain.com',
        '',
      ];
      for (const em of invalidEmails) {
        const dto = plainToInstance(CreateComplaintDto, {
          ...validBasePayload,
          email: em,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const emailError = errors.find((e) => e.property === 'email');
        expect(emailError).toBeDefined();
      }
    });

    it('should reject invalid claimType and goodType enums', async () => {
      const invalidClaimTypes = ['SUGERENCIA', 'DENUNCIA', 'FELICITACION', ''];
      for (const ct of invalidClaimTypes) {
        const dto = plainToInstance(CreateComplaintDto, {
          ...validBasePayload,
          claimType: ct,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const ctError = errors.find((e) => e.property === 'claimType');
        expect(ctError).toBeDefined();
      }

      const invalidGoodTypes = ['INMUEBLE', 'AUTOMOVIL', 'CRIPTOMONEDA', ''];
      for (const gt of invalidGoodTypes) {
        const dto = plainToInstance(CreateComplaintDto, {
          ...validBasePayload,
          goodType: gt,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const gtError = errors.find((e) => e.property === 'goodType');
        expect(gtError).toBeDefined();
      }
    });

    it('should reject missing mandatory Indecopi fields (fullName, address, phone, claimDetail, consumerRequest)', async () => {
      const requiredFields = [
        'fullName',
        'address',
        'phone',
        'claimDetail',
        'consumerRequest',
        'goodDescription',
      ];

      for (const field of requiredFields) {
        const payload: any = { ...validBasePayload };
        delete payload[field];
        const dto = plainToInstance(CreateComplaintDto, payload);
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const fieldError = errors.find((e) => e.property === field);
        expect(fieldError).toBeDefined();
      }
    });
  });

  // =========================================================================
  // 4. IN-MEMORY PDF GENERATION STREAM INTEGRITY & SECURITY
  // =========================================================================
  describe('4. In-Memory PDF Generation Stream Integrity & Stress Testing', () => {
    it('should produce a valid binary PDF buffer starting with %PDF- magic bytes without disk files', async () => {
      const sampleComplaint: ComplaintPdfData = {
        correlativeNumber: 'R-00001-2026',
        fullName: 'Carlos Mendoza Ramos',
        documentType: 'DNI',
        documentNumber: '45678901',
        phone: '987123456',
        email: 'carlos.mendoza@example.pe',
        address: 'Calle Los Pinos 450, San Isidro, Lima',
        isMinor: false,
        goodType: 'PRODUCTO',
        goodDescription: 'Entrega de material reciclable en centro de acopio San Isidro',
        amount: 50.0,
        claimType: 'RECLAMO',
        claimDetail: 'Se entregaron 10kg de PET pero el saldo de ECO tokens reflejó únicamente 2kg.',
        consumerRequest: 'Ajuste del saldo de tokens a 100 ECO y verificación de balanza.',
        createdAt: new Date('2026-08-24T10:00:00Z'),
      };

      const buffer = await complaintsService.generateComplaintPdf(sampleComplaint);

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(2000);

      // Verify PDF Magic Bytes: %PDF- (0x25, 0x50, 0x44, 0x46, 0x2D)
      const magicBytes = buffer.subarray(0, 5).toString('ascii');
      expect(magicBytes).toBe('%PDF-');

      // Verify PDF Trailer / EOF indicator
      const pdfString = buffer.toString('latin1');
      expect(pdfString).toContain('%%EOF');
      expect(pdfString).toContain('LIVORA');
    });

    it('should handle extreme text payloads (10,000 characters) and special unicode characters without stream failure', async () => {
      const extremeDetail = 'A'.repeat(5000) + ' Ñandú con acentos: áéíóú, símbolos: &%$#@! y emojis 🌿♻️ ' + 'B'.repeat(5000);
      const sampleComplaint: ComplaintPdfData = {
        correlativeNumber: 'Q-00001-2026',
        fullName: 'María del Carmen Núñez-García <script>alert("xss")</script>',
        documentType: 'CE',
        documentNumber: '001234567',
        phone: '+51 912345678',
        email: 'maria.nunez@example.com',
        address: 'Jr. Junín 1234, Dpto. 402, Lima',
        isMinor: true,
        representativeName: 'Pedro Núñez Alvarado (Padre)',
        goodType: 'SERVICIO',
        goodDescription: 'Atención al usuario en módulo virtual de canjes',
        amount: null,
        claimType: 'QUEJA',
        claimDetail: extremeDetail,
        consumerRequest: 'Capacitación al personal de soporte y disculpas formales por escrito.',
        createdAt: new Date(),
      };

      const buffer = await complaintsService.generateComplaintPdf(sampleComplaint);

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(5000);
      expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('should execute end-to-end createComplaint pipeline: DB save -> PDF -> Brevo mail', async () => {
      const complaintDto: CreateComplaintDto = {
        documentType: 'DNI',
        documentNumber: '71234567',
        fullName: 'Ana Torres Vega',
        address: 'Av. Brasil 2500, Jesús María',
        phone: '955443322',
        email: 'ana.torres@example.com',
        isMinor: false,
        goodType: 'PRODUCTO',
        goodDescription: 'Canje de botella térmica en marketplace',
        amount: 35.0,
        claimType: 'RECLAMO',
        claimDetail: 'El producto entregado tenía una fisura en la tapa.',
        consumerRequest: 'Cambio de producto por uno en óptimas condiciones.',
      };

      const created = await complaintsService.createComplaint(complaintDto);

      expect(created).toBeDefined();
      expect(created.correlativeNumber).toMatch(/^R-\d{5}-\d{4}$/);
      expect(created.email).toBe('ana.torres@example.com');
      expect(mockMailService.sendComplaintConfirmationEmail).toHaveBeenCalledTimes(1);

      const [email, fullName, correlative, claimType, pdfBuffer] =
        mockMailService.sendComplaintConfirmationEmail.mock.calls[0];

      expect(email).toBe('ana.torres@example.com');
      expect(fullName).toBe('Ana Torres Vega');
      expect(correlative).toBe(created.correlativeNumber);
      expect(claimType).toBe('RECLAMO');
      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });

  // =========================================================================
  // 5. ARCO SOFT DELETE & WEB3 PRIVATE KEY DESTRUCTION
  // =========================================================================
  describe('5. ARCO Soft Delete & Irreversible Web3 Private Key Destruction', () => {
    const testUserId = 'user-arco-uuid-1234';
    const testEmail = 'user.for.erasure@livora.io';
    const testPrivateKey = 'SBXXXXXXXXXXXXXPRIVATEKEYTESTSECRETXXXXXXXXXX';
    const encryptionKey = 'test_wallet_aes256_secret_key_32b';
    const encryptedKey = CryptoUtil.encrypt(testPrivateKey, encryptionKey);

    beforeEach(() => {
      // Populate user and linked entities
      dbUsers.set(testUserId, {
        id: testUserId,
        email: testEmail,
        role: 'HOGAR',
        walletAddress: 'GAXXXXXXXXXXXXXPUBLICWALLETADDRESSTESTXXXXX',
        encryptedPrivateKey: encryptedKey,
        fcmToken: 'fcm-secret-token',
        receptionPin: '5678',
        isActive: true,
        deletedAt: null,
      });

      dbStoreProfiles.set('sp-1', {
        id: 'sp-1',
        userId: testUserId,
        businessName: 'Mi Tienda Verde',
        ruc: '20123456789',
        address: 'Av. Larco 500',
        bankAccount: '191-12345678-0-12',
        logoUrl: 'https://livora.org/logo.png',
      });

      dbKycApplications.set('kyc-1', {
        id: 'kyc-1',
        userId: testUserId,
        documentUrl: 'https://livora.org/kyc/dni.jpg',
        status: 'APPROVED',
      });

      dbComplaints.push({
        id: 'comp-1',
        userId: testUserId,
        correlativeNumber: 'R-00001-2026',
        subject: 'Reclamo original',
        description: 'Detalle con datos personales y sensibles del usuario',
      });

      dbNotifications.push({
        id: 'notif-1',
        userId: testUserId,
        message: 'Tu canje fue exitoso',
      });

      dbBetaSignups.push({
        id: 'beta-1',
        email: testEmail,
      });
    });

    it('should irreversibly destroy encryptedPrivateKey, anonymize email, and set soft delete flags', async () => {
      // 1. Verify before state
      const beforeUser = dbUsers.get(testUserId);
      expect(beforeUser.encryptedPrivateKey).not.toBeNull();
      expect(CryptoUtil.decrypt(beforeUser.encryptedPrivateKey, encryptionKey)).toBe(testPrivateKey);
      expect(beforeUser.email).toBe(testEmail);
      expect(beforeUser.isActive).toBe(true);
      expect(beforeUser.deletedAt).toBeNull();

      // 2. Execute ARCO Account Cancellation
      const result = await usersService.cancelAccountARCO(testUserId);
      expect(result.success).toBe(true);
      expect(result.message).toContain('conforme a la Ley 29733');

      // 3. Verify User state after ARCO
      const afterUser = dbUsers.get(testUserId);
      expect(afterUser.encryptedPrivateKey).toBeNull(); // Irreversibly destroyed
      expect(afterUser.email).toMatch(/^deleted_user-arc_\d+@deleted\.livora\.org$/);
      expect(afterUser.fcmToken).toBeNull();
      expect(afterUser.receptionPin).toBeNull();
      expect(afterUser.isActive).toBe(false);
      expect(afterUser.deletedAt).toBeInstanceOf(Date);
      // Public wallet address preserved for ledger integrity
      expect(afterUser.walletAddress).toBe('GAXXXXXXXXXXXXXPUBLICWALLETADDRESSTESTXXXXX');

      // 4. Verify linked entities anonymized / purged
      const storeProfile = dbStoreProfiles.get('sp-1');
      expect(storeProfile.businessName).toBe('Tienda Anonimizada (ARCO)');
      expect(storeProfile.ruc).toBe('00000000000');
      expect(storeProfile.address).toBe('Dirección Anonimizada');
      expect(storeProfile.bankAccount).toBe('ANONIMIZADO');
      expect(storeProfile.logoUrl).toBeNull();

      const kyc = dbKycApplications.get('kyc-1');
      expect(kyc.documentUrl).toBeNull();
      expect(kyc.status).toBe('REJECTED');

      const complaint = dbComplaints.find((c) => c.id === 'comp-1');
      expect(complaint.subject).toBe('Queja Anonimizada');
      expect(complaint.description).toContain('Ley 29733');

      expect(dbNotifications.length).toBe(0);
      expect(dbBetaSignups.length).toBe(0);
    });

    it('should be idempotent and throw NotFoundException if called on an already cancelled user', async () => {
      // First cancellation succeeds
      await usersService.cancelAccountARCO(testUserId);

      // Second cancellation fails
      await expect(usersService.cancelAccountARCO(testUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
