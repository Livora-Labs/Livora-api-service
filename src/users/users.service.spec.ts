import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: PrismaService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('testSecretKey32CharacterLength!'),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should update fcmToken', async () => {
    mockPrismaService.user.update.mockResolvedValue({ id: 'user-1', fcmToken: 'new-token' });
    const result = await service.updateFcmToken('user-1', 'new-token');
    expect(mockPrismaService.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { fcmToken: 'new-token' },
    });
    expect(result.fcmToken).toBe('new-token');
  });

  it('should delete (anonymize) user account for GDPR compliance', async () => {
    mockPrismaService.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'deleted_user-1_12345@deleted.livora.org',
      encryptedPrivateKey: null,
      fcmToken: null,
      receptionPin: null,
    });

    const result = await service.deleteAccountGDPR('user-1');

    expect(mockPrismaService.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        email: expect.stringContaining('@deleted.livora.org'),
        encryptedPrivateKey: null,
        fcmToken: null,
        receptionPin: null,
      },
    });

    expect(result.encryptedPrivateKey).toBeNull();
    expect(result.fcmToken).toBeNull();
    expect(result.email).toContain('@deleted.livora.org');
  });
});
