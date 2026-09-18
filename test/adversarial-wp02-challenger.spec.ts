import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { Role } from '@prisma/client';

import { CryptoUtil } from '../src/common/utils/crypto.util';
import { ComplaintsController } from '../src/complaints/complaints.controller';
import { ComplaintsService } from '../src/complaints/complaints.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/services/mail.service';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { SupabaseService } from '../src/supabase/supabase.service';
import { UsersService } from '../src/users/users.service';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

import { UploadsService } from '../src/uploads/uploads.service';
import { validateMagicBytes } from '../src/uploads/utils/magic-bytes.util';
import { ConfigService } from '@nestjs/config';

describe('CHALLENGER WP-02: Empirical Adversarial Stress Suite', () => {
  const SECRET_KEY = 'superSecretEncryptionMasterKey32!';
  const KNOWN_PRIVATE_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
  const JWT_SECRET = 'test-jwt-secret-challenger-wp02';

  beforeAll(() => {
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
  });

  // =========================================================================
  // DOMAIN 1: CryptoUtil Adversarial Stress Testing
  // =========================================================================
  describe('Domain 1: CryptoUtil Empirical Adversarial Tests', () => {
    it('1.1 should fail when salt is corrupted by 1 bit or byte in 4-part ciphertext', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const [saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');

      // Alter first byte of salt
      const saltBuf = Buffer.from(saltHex, 'hex');
      saltBuf[0] ^= 0xff;
      const corruptedSaltHex = saltBuf.toString('hex');
      const tamperedCiphertext = `${corruptedSaltHex}:${ivHex}:${tagHex}:${dataHex}`;

      expect(() => CryptoUtil.decrypt(tamperedCiphertext, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );
    });

    it('1.2 should fail when salt length is invalid (truncated or oversized)', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const [saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');

      // Truncate salt to 15 bytes (30 hex chars)
      const shortSalt = saltHex.slice(0, 30);
      expect(() => CryptoUtil.decrypt(`${shortSalt}:${ivHex}:${tagHex}:${dataHex}`, SECRET_KEY)).toThrow(
        'Invalid encrypted text format',
      );

      // Oversize salt to 17 bytes (34 hex chars)
      const longSalt = saltHex + 'aa';
      expect(() => CryptoUtil.decrypt(`${longSalt}:${ivHex}:${tagHex}:${dataHex}`, SECRET_KEY)).toThrow(
        'Invalid encrypted text format',
      );
    });

    it('1.3 should fail when IV is altered, truncated, or tampered', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const [saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');

      // Bit flip in IV
      const ivBuf = Buffer.from(ivHex, 'hex');
      ivBuf[0] ^= 0x01;
      const tamperedIv = `${saltHex}:${ivBuf.toString('hex')}:${tagHex}:${dataHex}`;
      expect(() => CryptoUtil.decrypt(tamperedIv, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );

      // Invalid IV length (11 bytes = 22 hex chars)
      const shortIv = `${saltHex}:${ivHex.slice(0, 22)}:${tagHex}:${dataHex}`;
      expect(() => CryptoUtil.decrypt(shortIv, SECRET_KEY)).toThrow('Invalid encrypted text format');
    });

    it('1.4 should fail when AuthTag is altered, zeroed, or tampered', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const [saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');

      // Invert last byte of authTag
      const tagBuf = Buffer.from(tagHex, 'hex');
      tagBuf[tagBuf.length - 1] ^= 0xff;
      const tamperedTag = `${saltHex}:${ivHex}:${tagBuf.toString('hex')}:${dataHex}`;
      expect(() => CryptoUtil.decrypt(tamperedTag, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );

      // All zero authTag
      const zeroTag = `${saltHex}:${ivHex}:${Buffer.alloc(16).toString('hex')}:${dataHex}`;
      expect(() => CryptoUtil.decrypt(zeroTag, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );
    });

    it('1.5 should fail when wrong master encryption key is supplied', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const wrongKey = 'wrongEncryptionMasterKey32Length!';

      expect(() => CryptoUtil.decrypt(ciphertext, wrongKey)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );
    });

    it('1.6 should fail when ciphertext payload is corrupted or truncated', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const [saltHex, ivHex, tagHex, dataHex] = ciphertext.split(':');

      // Alter ciphertext byte
      const dataBuf = Buffer.from(dataHex, 'hex');
      dataBuf[0] ^= 0x55;
      const corruptedPayload = `${saltHex}:${ivHex}:${tagHex}:${dataBuf.toString('hex')}`;
      expect(() => CryptoUtil.decrypt(corruptedPayload, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );
    });

    it('1.7 should verify guaranteed buffer zeroization in withDecryptedKey on success AND on exception', async () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      let capturedSuccessBuf: Buffer | null = null;

      // 1. Normal execution zeroization test
      const result = await CryptoUtil.withDecryptedKey(ciphertext, SECRET_KEY, (buf) => {
        capturedSuccessBuf = buf;
        expect(buf.toString('utf8')).toBe(KNOWN_PRIVATE_KEY);
        return 'success';
      });
      expect(result).toBe('success');
      expect(capturedSuccessBuf).not.toBeNull();
      expect((capturedSuccessBuf as unknown as Buffer).every((b) => b === 0)).toBe(true);

      // 2. Exception/crash zeroization test (adversarial: callback throws error)
      let capturedErrorBuf: Buffer | null = null;
      let errorThrown = false;
      try {
        await CryptoUtil.withDecryptedKey(ciphertext, SECRET_KEY, (buf) => {
          capturedErrorBuf = buf;
          expect(buf.toString('utf8')).toBe(KNOWN_PRIVATE_KEY);
          throw new Error('Fatal unhandled error inside business action');
        });
      } catch (err: any) {
        errorThrown = true;
        expect(err.message).toBe('Fatal unhandled error inside business action');
      }
      expect(errorThrown).toBe(true);
      expect(capturedErrorBuf).not.toBeNull();
      // Even though an exception occurred, the finally block MUST have zeroized the buffer!
      expect((capturedErrorBuf as unknown as Buffer).every((b) => b === 0)).toBe(true);
    });

    it('1.8 decryptToBuffer allows explicit caller zeroization via buf.fill(0)', () => {
      const ciphertext = CryptoUtil.encrypt(KNOWN_PRIVATE_KEY, SECRET_KEY);
      const buf = CryptoUtil.decryptToBuffer(ciphertext, SECRET_KEY);
      expect(buf.toString('utf8')).toBe(KNOWN_PRIVATE_KEY);

      buf.fill(0);
      expect(buf.every((b) => b === 0)).toBe(true);
    });

    it('1.9 should verify 3-part legacy backward compatibility (static PBKDF2 salt & legacy SHA-256)', () => {
      // A. Legacy PBKDF2 with static salt
      const legacyPbkdf2Key = crypto.pbkdf2Sync(
        SECRET_KEY,
        'livora_wallet_encryption_salt_kdf_v1',
        100000,
        32,
        'sha512',
      );
      const iv1 = crypto.randomBytes(12);
      const cipher1 = crypto.createCipheriv('aes-256-gcm', legacyPbkdf2Key, iv1);
      let enc1 = cipher1.update(KNOWN_PRIVATE_KEY, 'utf8', 'hex');
      enc1 += cipher1.final('hex');
      const tag1 = cipher1.getAuthTag().toString('hex');
      const legacy3PartPbkdf2 = `${iv1.toString('hex')}:${tag1}:${enc1}`;

      expect(CryptoUtil.decrypt(legacy3PartPbkdf2, SECRET_KEY)).toBe(KNOWN_PRIVATE_KEY);

      // B. Legacy SHA-256
      const legacySha256Key = crypto.createHash('sha256').update(SECRET_KEY).digest();
      const iv2 = crypto.randomBytes(12);
      const cipher2 = crypto.createCipheriv('aes-256-gcm', legacySha256Key, iv2);
      let enc2 = cipher2.update(KNOWN_PRIVATE_KEY, 'utf8', 'hex');
      enc2 += cipher2.final('hex');
      const tag2 = cipher2.getAuthTag().toString('hex');
      const legacy3PartSha256 = `${iv2.toString('hex')}:${tag2}:${enc2}`;

      expect(CryptoUtil.decrypt(legacy3PartSha256, SECRET_KEY)).toBe(KNOWN_PRIVATE_KEY);

      // C. Corrupted 3-part payload fails cleanly
      const corrupted3Part = `${iv2.toString('hex')}:${Buffer.alloc(16).toString('hex')}:${enc2}`;
      expect(() => CryptoUtil.decrypt(corrupted3Part, SECRET_KEY)).toThrow(
        'No se pudo descifrar la información o la firma AuthTag no es válida',
      );
    });
  });

  // =========================================================================
  // DOMAIN 2: Complaints Anti-IDOR & PII Protection
  // =========================================================================
  describe('Domain 2: Complaints Anti-IDOR & PII Protection Tests', () => {
    let app: NestFastifyApplication;
    let storedComplaints: Map<string, any>;
    const CITIZEN_USER_ID = 'citizen-user-uuid-101';
    const ADMIN_USER_ID = 'admin-user-uuid-999';
    const OTHER_USER_ID = 'citizen-user-uuid-202';

    const citizenJwt = jwt.sign({ sub: CITIZEN_USER_ID }, JWT_SECRET);
    const adminJwt = jwt.sign({ sub: ADMIN_USER_ID }, JWT_SECRET);
    const otherUserJwt = jwt.sign({ sub: OTHER_USER_ID }, JWT_SECRET);

    const testCorrelative = 'R-00042-2026';
    const testDocNumber = '45891234';
    const testFullName = 'Maria Elena Delgado Flores';
    const testEmail = 'maria.delgado@corporacion.pe';
    const testAddress = 'Av. Primavera 1234, Santiago de Surco';
    const testPhone = '998877665';

    beforeAll(async () => {
      storedComplaints = new Map();
      storedComplaints.set(testCorrelative, {
        id: 'complaint-uuid-42',
        correlativeNumber: testCorrelative,
        documentType: 'DNI',
        documentNumber: testDocNumber,
        fullName: testFullName,
        address: testAddress,
        phone: testPhone,
        email: testEmail,
        goodType: 'PRODUCTO',
        goodDescription: 'Contenedor inteligente de reciclaje',
        claimType: 'RECLAMO',
        claimDetail: 'El sensor ultrasónico del contenedor falló al registrar el depósito.',
        consumerRequest: 'Calibración técnica del sensor o reemplazo del equipo.',
        status: 'IN_REVIEW',
        userId: CITIZEN_USER_ID,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        updatedAt: new Date('2026-09-02T12:00:00Z'),
      });

      const mockPrisma: any = {
        getReadClient: () => mockPrisma,
        $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
        complaint: {
          findUnique: jest.fn(({ where }: { where: { id?: string; correlativeNumber?: string } }) => {
            if (where.id) {
              for (const c of storedComplaints.values()) {
                if (c.id === where.id) return Promise.resolve(c);
              }
            }
            if (where.correlativeNumber) {
              return Promise.resolve(storedComplaints.get(where.correlativeNumber) || null);
            }
            return Promise.resolve(null);
          }),
        },
      };
      mockPrisma.read = mockPrisma;

      const mockUsersService = {
        findById: jest.fn((id: string) => {
          if (id === CITIZEN_USER_ID) {
            return Promise.resolve({ id: CITIZEN_USER_ID, role: Role.HOGAR, isActive: true, deletedAt: null });
          }
          if (id === OTHER_USER_ID) {
            return Promise.resolve({ id: OTHER_USER_ID, role: Role.HOGAR, isActive: true, deletedAt: null });
          }
          if (id === ADMIN_USER_ID) {
            return Promise.resolve({ id: ADMIN_USER_ID, role: Role.ADMIN, isActive: true, deletedAt: null });
          }
          return Promise.resolve(null);
        }),
      };

      const mockSupabaseService = {
        getClient: jest.fn().mockReturnValue({
          auth: {
            getUser: jest.fn().mockResolvedValue({ data: { user: null }, error: new Error('Invalid token') }),
          },
        }),
      };

      const mockMailService = {
        sendComplaintConfirmationEmail: jest.fn().mockResolvedValue(undefined),
      };

      const moduleRef = await Test.createTestingModule({
        controllers: [ComplaintsController],
        providers: [
          ComplaintsService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: UsersService, useValue: mockUsersService },
          { provide: SupabaseService, useValue: mockSupabaseService },
          { provide: MailService, useValue: mockMailService },
          Reflector,
          RolesGuard,
          SupabaseAuthGuard,
        ],
      }).compile();

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
      if (app) await app.close();
    });

    it('2.1 POST /complaints/track: attempt document bypass with mismatched document number (must return 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/complaints/track')
        .send({
          correlativeNumber: testCorrelative,
          documentNumber: '87654321',
        })
        .expect(404);

      expect(res.body.detail || res.body.message).toContain('No se encontró ninguna reclamación');
    });

    it('2.2 POST /complaints/track: attempt document bypass with malformed or invalid DTO (must return 400)', async () => {
      // Missing documentNumber
      await request(app.getHttpServer())
        .post('/complaints/track')
        .send({ correlativeNumber: testCorrelative })
        .expect(400);

      // Malformed correlative number (regex fail)
      await request(app.getHttpServer())
        .post('/complaints/track')
        .send({ correlativeNumber: 'NOT-A-CORRELATIVE', documentNumber: testDocNumber })
        .expect(400);
    });

    it('2.3 POST /complaints/track: matching credentials return 200 with strictly masked PII', async () => {
      const res = await request(app.getHttpServer())
        .post('/complaints/track')
        .send({
          correlativeNumber: testCorrelative,
          documentNumber: testDocNumber,
        })
        .expect(200);

      const data = res.body;
      expect(data.correlativeNumber).toBe(testCorrelative);
      expect(data.claimType).toBe('RECLAMO');
      expect(data.status).toBe('IN_REVIEW');

      // Masked full name: "M***a E***a D*****o F****s"
      expect(data.fullName).not.toBe(testFullName);
      expect(data.fullName).toContain('*');
      expect(data.fullName.startsWith('M')).toBe(true);

      // Masked email: "m****o@corporacion.pe"
      expect(data.email).not.toBe(testEmail);
      expect(data.email).toContain('*');
      expect(data.email.endsWith('@corporacion.pe')).toBe(true);

      // Masked document number: "******34"
      expect(data.documentNumberMasked).toBe('******34');
      expect(data.documentNumber).toBeUndefined();

      // Cleartext address and phone MUST NOT exist
      expect(data.address).toBeUndefined();
      expect(data.phone).toBeUndefined();
      expect(data.userId).toBeUndefined();
    });

    it('2.4 POST /complaints/track/pdf: reject download if document number does not match (404)', async () => {
      await request(app.getHttpServer())
        .post('/complaints/track/pdf')
        .send({
          correlativeNumber: testCorrelative,
          documentNumber: '00000000',
        })
        .expect(404);
    });

    it('2.5 GET /complaints/correlative/:id: fails 401 when called without auth credentials', async () => {
      await request(app.getHttpServer())
        .get(`/complaints/correlative/${testCorrelative}`)
        .expect(401);
    });

    it('2.6 GET /complaints/correlative/:id: fails 403 when called with non-admin (HOGAR) role', async () => {
      await request(app.getHttpServer())
        .get(`/complaints/correlative/${testCorrelative}`)
        .set('Authorization', `Bearer ${citizenJwt}`)
        .expect(403);
    });

    it('2.7 GET /complaints/correlative/:id: succeeds with 200 when called by ADMIN role', async () => {
      const res = await request(app.getHttpServer())
        .get(`/complaints/correlative/${testCorrelative}`)
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.body.correlativeNumber).toBe(testCorrelative);
      expect(res.body.fullName).toBe(testFullName);
    });

    it('2.8 GET /complaints/:id: citizen cannot access another citizen complaint (anti-IDOR 403)', async () => {
      await request(app.getHttpServer())
        .get('/complaints/complaint-uuid-42')
        .set('Authorization', `Bearer ${otherUserJwt}`)
        .expect(403);
    });
  });

  // =========================================================================
  // DOMAIN 3: Uploads Magic Bytes & KYC Private Isolation
  // =========================================================================
  describe('Domain 3: Uploads Magic Bytes & KYC Private Storage Tests', () => {
    let uploadsService: UploadsService;
    let mockStorage: any;
    let mockClient: any;

    beforeEach(() => {
      mockStorage = {
        upload: jest.fn().mockResolvedValue({ error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://storage.livora.pe/public/test.png' } }),
        createSignedUrl: jest.fn().mockResolvedValue({
          data: { signedUrl: 'https://storage.livora.pe/signed/kyc-doc.pdf?token=exp900' },
          error: null,
        }),
        getBucket: jest.fn().mockResolvedValue({ data: { name: 'bucket' } }),
        createBucket: jest.fn().mockResolvedValue({ error: null }),
      };

      mockClient = {
        storage: {
          from: jest.fn().mockReturnValue(mockStorage),
          getBucket: mockStorage.getBucket,
          createBucket: mockStorage.createBucket,
        },
      };

      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
          if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-service-key';
          if (key === 'SUPABASE_STORAGE_BUCKET') return 'livora-uploads';
          if (key === 'SUPABASE_STORAGE_KYC_BUCKET') return 'livora-kyc-private';
          return null;
        }),
      } as unknown as ConfigService;

      uploadsService = new UploadsService(configService);
      (uploadsService as any).client = mockClient;
    });

    it('3.1 validateMagicBytes identifies valid PNG, JPEG, and PDF signatures', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(validateMagicBytes(pngHeader)).toEqual({ mime: 'image/png', extension: 'png' });

      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(validateMagicBytes(jpegHeader)).toEqual({ mime: 'image/jpeg', extension: 'jpg' });

      const pdfHeader = Buffer.from('%PDF-1.7 header');
      expect(validateMagicBytes(pdfHeader)).toEqual({ mime: 'application/pdf', extension: 'pdf' });
    });

    it('3.2 rejects script disguised as .jpg (must throw BadRequestException 400)', async () => {
      const fakeJpg: any = {
        originalname: 'exploit.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('#!/bin/bash\necho "invalid image"'),
        size: 40,
      };

      await expect(uploadsService.upload(fakeJpg, 'collection')).rejects.toThrow(BadRequestException);
    });

    it('3.3 rejects HTML/text script disguised as .png (must throw BadRequestException 400)', async () => {
      const fakePng: any = {
        originalname: 'fake.png',
        mimetype: 'image/png',
        buffer: Buffer.from('<div class="avatar">not an image</div>'),
        size: 35,
      };

      await expect(uploadsService.upload(fakePng, 'collection')).rejects.toThrow(BadRequestException);
    });

    it('3.4 rejects plain text disguised as .pdf (must throw BadRequestException 400)', async () => {
      const fakePdf: any = {
        originalname: 'fake.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('Just plain text pretending to be a pdf document'),
        size: 45,
      };

      await expect(uploadsService.upload(fakePdf, 'kyc')).rejects.toThrow(BadRequestException);
    });

    it('3.5 rejects PDF files for non-KYC purposes (collection or receipt)', async () => {
      const validPdf: any = {
        originalname: 'document.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 genuine content'),
        size: 200,
      };

      await expect(uploadsService.upload(validPdf, 'collection')).rejects.toThrow(
        'Los archivos PDF solo están permitidos para el propósito KYC.',
      );

      await expect(uploadsService.upload(validPdf, 'receipt')).rejects.toThrow(
        'Los archivos PDF solo están permitidos para el propósito KYC.',
      );
    });

    it('3.6 isolates KYC uploads in livora-kyc-private bucket with 15-minute presigned URL', async () => {
      const validKycPdf: any = {
        originalname: 'dni-scan.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-1.5 national identity document data'),
        size: 1024,
      };

      const result = await uploadsService.upload(validKycPdf, 'kyc', 'user-uuid-888');

      // Verify routing to livora-kyc-private
      expect(mockClient.storage.from).toHaveBeenCalledWith('livora-kyc-private');
      // Verify storage path begins with user ID
      expect(mockStorage.upload).toHaveBeenCalledWith(
        expect.stringMatching(/^user-uuid-888\/[0-9a-f-]+\.pdf$/),
        validKycPdf.buffer,
        expect.objectContaining({ contentType: 'application/pdf' }),
      );
      // Verify signed URL created with 900 seconds (15 minutes)
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith(
        expect.stringMatching(/^user-uuid-888\/[0-9a-f-]+\.pdf$/),
        900,
      );
      expect(result.expiresIn).toBe(900);
      expect(result.url).toBe('https://storage.livora.pe/signed/kyc-doc.pdf?token=exp900');
    });

    it('3.7 getPresignedKycUrl queries livora-kyc-private bucket with 900s expiration', async () => {
      const signedUrl = await uploadsService.getPresignedKycUrl('user-uuid-888/dni-scan.pdf', 900);

      expect(mockClient.storage.from).toHaveBeenCalledWith('livora-kyc-private');
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith('user-uuid-888/dni-scan.pdf', 900);
      expect(signedUrl).toBe('https://storage.livora.pe/signed/kyc-doc.pdf?token=exp900');
    });
  });
});
