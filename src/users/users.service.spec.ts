import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ConfigService } from '@nestjs/config';
import { WalletsService } from '../wallets/wallets.service';
import { Role } from '@prisma/client';

describe('UsersService', () => {
  let service: UsersService;
  let mockPrismaService: any;
  let mockSupabaseService: any;
  let mockSupabaseClient: any;

  beforeEach(async () => {
    mockSupabaseClient = {
      auth: {
        admin: {
          deleteUser: jest.fn().mockResolvedValue({ error: null }),
        },
      },
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient),
    };

    mockPrismaService = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      storeProfile: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      kycApplication: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      complaint: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      notification: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      betaSignup: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      consentAudit: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb) => {
        return cb(mockPrismaService);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SupabaseService, useValue: mockSupabaseService },
        {
          provide: WalletsService,
          useValue: {
            getBalance: jest.fn().mockResolvedValue('0.0'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('testSecretKey32CharacterLength!'),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw ConflictException if user already exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'existing-id',
        email: 'user@livora.io',
      });

      await expect(
        service.create('supabase-id', {
          email: 'user@livora.io',
          password: 'Password123!',
          role: Role.HOGAR,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should generate wallet and create user in database', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'supabase-id',
        email: 'user@livora.io',
        role: Role.HOGAR,
        walletAddress: 'GDABC123...',
        encryptedPrivateKey: 'iv:salt:tag:payload',
        isActive: true,
        deletedAt: null,
      });

      const result = await service.create('supabase-id', {
        email: 'user@livora.io',
        password: 'Password123!',
        role: Role.HOGAR,
      });

      expect(result.id).toBe('supabase-id');
      expect(result.walletAddress).toBe('GDABC123...');
      expect((result as any).encryptedPrivateKey).toBeUndefined();
    });
  });

  describe('updateFcmToken', () => {
    it('should update fcmToken', async () => {
      mockPrismaService.user.update.mockResolvedValue({
        id: 'user-1',
        fcmToken: 'new-token',
      });
      const result = await service.updateFcmToken('user-1', 'new-token');
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { fcmToken: 'new-token' },
      });
      expect(result.fcmToken).toBe('new-token');
    });
  });

  describe('cancelAccountARCO & deleteAccountGDPR', () => {
    it('should throw NotFoundException if user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.cancelAccountARCO('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if user is already soft-deleted or inactive', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'deleted_user-1@deleted.livora.org',
        deletedAt: new Date(),
        isActive: false,
      });

      await expect(service.cancelAccountARCO('user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should perform multi-table atomic transaction and Supabase deletion on valid ARCO request', async () => {
      const activeUser = {
        id: 'user-1234-5678',
        email: 'citizen@livora.io',
        walletAddress: 'GAW1234567890STEL',
        encryptedPrivateKey: 'secret-key-payload',
        fcmToken: 'fcm-token-abc',
        receptionPin: '1234',
        isActive: true,
        deletedAt: null,
      };
      mockPrismaService.user.findUnique.mockResolvedValue(activeUser);

      const result = await service.cancelAccountARCO('user-1234-5678');

      expect(result.success).toBe(true);
      expect(result.message).toContain('conforme a la Ley 29733');

      // Verify transaction execution
      expect(mockPrismaService.$transaction).toHaveBeenCalled();

      // 1. User anonymization & private key destruction
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1234-5678' },
        data: expect.objectContaining({
          email: expect.stringMatching(
            /^deleted_user-123_\d+@deleted\.livora\.org$/,
          ),
          encryptedPrivateKey: null,
          fcmToken: null,
          receptionPin: null,
          isActive: false,
          deletedAt: expect.any(Date),
        }),
      });

      // 2. Store profile anonymization
      expect(mockPrismaService.storeProfile.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1234-5678' },
        data: expect.objectContaining({
          businessName: 'Tienda Anonimizada (ARCO)',
          ruc: '00000000000',
          bankAccount: 'ANONIMIZADO',
          logoUrl: null,
        }),
      });

      // 3. KYC document wipe & rejection
      expect(mockPrismaService.kycApplication.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1234-5678' },
        data: {
          documentUrl: null,
          status: 'REJECTED',
        },
      });

      // 4. Complaints anonymization
      expect(mockPrismaService.complaint.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1234-5678' },
        data: expect.objectContaining({
          subject: 'Queja Anonimizada',
        }),
      });

      // 5. Notifications wipe
      expect(mockPrismaService.notification.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1234-5678' },
      });

      // 6. Beta waitlist wipe
      expect(mockPrismaService.betaSignup.deleteMany).toHaveBeenCalledWith({
        where: { email: 'citizen@livora.io' },
      });

      // 7. Supabase user deletion
      expect(mockSupabaseClient.auth.admin.deleteUser).toHaveBeenCalledWith(
        'user-1234-5678',
      );
    });

    it('should complete ARCO deletion successfully even if Supabase deleteUser throws', async () => {
      const activeUser = {
        id: 'user-999',
        email: 'user999@livora.io',
        isActive: true,
        deletedAt: null,
      };
      mockPrismaService.user.findUnique.mockResolvedValue(activeUser);
      mockSupabaseClient.auth.admin.deleteUser.mockRejectedValue(
        new Error('Supabase network timeout'),
      );

      const result = await service.cancelAccountARCO('user-999');

      expect(result.success).toBe(true);
      expect(mockPrismaService.user.update).toHaveBeenCalled();
    });

    it('should support deleteAccountGDPR alias', async () => {
      const activeUser = {
        id: 'user-gdpr-1',
        email: 'gdpr@livora.io',
        isActive: true,
        deletedAt: null,
      };
      mockPrismaService.user.findUnique.mockResolvedValue(activeUser);

      const result = await service.deleteAccountGDPR('user-gdpr-1');
      expect(result.success).toBe(true);
    });
  });

  describe('getConsentAudits', () => {
    it('should return consent audit records for a user', async () => {
      const audits = [
        {
          id: 'audit-1',
          userId: 'user-1',
          ipAddress: '190.236.1.1',
          userAgent: 'Mozilla',
          termsVersion: '1.0.0',
          privacyVersion: '1.0.0',
          documentHash: 'abc',
          consentedAt: new Date(),
        },
      ];
      mockPrismaService.consentAudit.findMany.mockResolvedValue(audits);

      const result = await service.getConsentAudits('user-1');
      expect(result).toEqual(audits);
      expect(mockPrismaService.consentAudit.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { consentedAt: 'desc' },
      });
    });
  });
});
