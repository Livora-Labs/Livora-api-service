import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { CryptoUtil } from '../common/utils/crypto.util';
import { StrKey } from '@stellar/stellar-sdk';

describe('UsersService & Compliance Adversarial Unit Tests', () => {
  let service: UsersService;
  let mockPrisma: any;
  let mockSupabaseClient: any;
  const encryptionKey = 'test_adversarial_aes256_secret_key!';

  beforeEach(async () => {
    mockSupabaseClient = {
      auth: {
        admin: {
          deleteUser: jest.fn().mockResolvedValue({ error: null }),
        },
      },
    };

    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      storeProfile: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      kycApplication: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      complaint: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      notification: {
        deleteMany: jest.fn().mockResolvedValue({ count: 10 }),
      },
      betaSignup: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      consentAudit: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => {
        return cb(mockPrisma);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: SupabaseService,
          useValue: { getClient: () => mockSupabaseClient },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WALLET_ENCRYPTION_KEY') return encryptionKey;
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('Adversarial Wallet Generation & Cryptographic Verification', () => {
    it('generates valid Stellar ed25519 public key and correctly encrypted private key', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(({ data }: any) => ({
        ...data,
        isActive: true,
        deletedAt: null,
      }));

      const created = await service.create('supabase-uuid-adv-1', {
        email: 'wallet.adv@livora.io',
        password: 'Password123!',
        role: Role.HOGAR,
      });

      expect(created.id).toBe('supabase-uuid-adv-1');
      expect(created.walletAddress).toBeDefined();
      // Verify ed25519 Stellar public key using SDK StrKey validator
      expect(StrKey.isValidEd25519PublicKey(created.walletAddress!)).toBe(true);

      // Verify create call received valid AES-256-GCM cipher payload
      const prismaCreateCall = mockPrisma.user.create.mock.calls[0][0];
      const encryptedKey = prismaCreateCall.data.encryptedPrivateKey;
      expect(encryptedKey).toBeDefined();

      // Verify decryption recovers a valid Stellar secret key (S-address)
      const decryptedSecret = CryptoUtil.decrypt(encryptedKey, encryptionKey);
      expect(StrKey.isValidEd25519SecretSeed(decryptedSecret)).toBe(true);

      // Verify return object omits encryptedPrivateKey
      expect((created as any).encryptedPrivateKey).toBeUndefined();
    });

    it('rejects duplicate email during user creation', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'existing-id',
        email: 'existing@livora.io',
      });

      await expect(
        service.create('supabase-new-id', {
          email: 'existing@livora.io',
          password: 'Password123!',
          role: Role.HOGAR,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Adversarial ARCO Multi-Table Cascade & Idempotency', () => {
    it('anonymizes multiple associated entities and destroys Web3 key', async () => {
      const activeUser = {
        id: 'user-multi-rel-1',
        email: 'citizen.multi@livora.io',
        walletAddress: 'GAW_CITIZEN_MULTI_REL_1234567890',
        encryptedPrivateKey: 'iv:salt:authTag:payload',
        fcmToken: 'fcm-secret-token',
        receptionPin: '9876',
        isActive: true,
        deletedAt: null,
      };
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);

      const res = await service.cancelAccountARCO('user-multi-rel-1');
      expect(res.success).toBe(true);

      // Verify User update
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-multi-rel-1' },
        data: {
          email: expect.stringMatching(
            /^deleted_user-mul_\d+@deleted\.livora\.org$/,
          ),
          encryptedPrivateKey: null,
          fcmToken: null,
          receptionPin: null,
          isActive: false,
          deletedAt: expect.any(Date),
        },
      });

      // Verify StoreProfile update
      expect(mockPrisma.storeProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-multi-rel-1' },
        data: {
          businessName: 'Tienda Anonimizada (ARCO)',
          ruc: '00000000000',
          address: 'Dirección Anonimizada',
          bankAccount: 'ANONIMIZADO',
          logoUrl: null,
        },
      });

      // Verify KycApplication update
      expect(mockPrisma.kycApplication.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-multi-rel-1' },
        data: {
          documentUrl: null,
          status: 'REJECTED',
        },
      });

      // Verify Complaint update
      expect(mockPrisma.complaint.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-multi-rel-1' },
        data: {
          subject: 'Queja Anonimizada',
          description:
            'Contenido suprimido por solicitud de cancelación ARCO (Ley 29733)',
        },
      });

      // Verify Notification delete
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-multi-rel-1' },
      });

      // Verify BetaSignup delete
      expect(mockPrisma.betaSignup.deleteMany).toHaveBeenCalledWith({
        where: { email: 'citizen.multi@livora.io' },
      });

      // Verify Supabase delete
      expect(mockSupabaseClient.auth.admin.deleteUser).toHaveBeenCalledWith(
        'user-multi-rel-1',
      );
    });

    it('rejects already deleted user on repeat ARCO attempt (idempotency defense)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'already-deleted-user',
        email: 'deleted_already@deleted.livora.org',
        isActive: false,
        deletedAt: new Date(),
      });

      await expect(
        service.cancelAccountARCO('already-deleted-user'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects inactive user with deletedAt=null', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'inactive-user',
        email: 'inactive@livora.io',
        isActive: false,
        deletedAt: null,
      });

      await expect(service.cancelAccountARCO('inactive-user')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('handles Supabase admin API failure gracefully without breaking local transaction result', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-supa-fail',
        email: 'supa.fail@livora.io',
        isActive: true,
        deletedAt: null,
      });
      mockSupabaseClient.auth.admin.deleteUser.mockRejectedValue(
        new Error('Supabase 503 Unavailable'),
      );

      const res = await service.cancelAccountARCO('user-supa-fail');
      expect(res.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalled();
    });
  });

  describe('Adversarial Consent Audit Querying', () => {
    it('retrieves consent audits ordered by consentedAt desc', async () => {
      const audits = [
        { id: 'audit-2', consentedAt: new Date(2026, 8, 2) },
        { id: 'audit-1', consentedAt: new Date(2026, 8, 1) },
      ];
      mockPrisma.consentAudit.findMany.mockResolvedValue(audits);

      const res = await service.getConsentAudits('user-audits-1');
      expect(res).toBe(audits);
      expect(mockPrisma.consentAudit.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-audits-1' },
        orderBy: { consentedAt: 'desc' },
      });
    });
  });
});
