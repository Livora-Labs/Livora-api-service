import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { IpfsService } from '../blockchain/services/ipfs.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { CollectionsService } from '../collections/collections.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestStatus } from '@prisma/client';

describe('CollectionsService - verifyPin', () => {
  let service: CollectionsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    collectionRequest: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    batch: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SupabaseService, useValue: {} },
        { provide: IpfsService, useValue: {} },
        { provide: WebsocketsService, useValue: {} },
        { provide: NotificationsService, useValue: { sendPushNotification: jest.fn() } },
      ],
    }).compile();

    service = module.get<CollectionsService>(CollectionsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should verify a correct PIN and update status to COMPLETED', async () => {
    const mockRequest = {
      id: 'req-1',
      status: RequestStatus.ACCEPTED,
      collectorId: 'collector-1',
      verificationPin: '1234',
    };
    const mockBatch = { id: 'batch-1' };

    mockPrismaService.collectionRequest.findUnique.mockResolvedValue(mockRequest);
    mockPrismaService.batch.findFirst.mockResolvedValue(mockBatch);
    mockPrismaService.collectionRequest.update.mockResolvedValue({
      ...mockRequest,
      status: RequestStatus.COMPLETED,
    });

    const result = await service.verifyPin('req-1', 'collector-1', { pin: '1234' });

    expect(prisma.collectionRequest.findUnique).toHaveBeenCalledWith({
      where: { id: 'req-1' },
    });
    expect(prisma.collectionRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: RequestStatus.COMPLETED, batchId: 'batch-1' },
    });
    expect(result.status).toBe(RequestStatus.COMPLETED);
  });

  it('should reject an incorrect PIN with BadRequestException', async () => {
    const mockRequest = {
      id: 'req-1',
      status: RequestStatus.ACCEPTED,
      collectorId: 'collector-1',
      verificationPin: '1234',
    };

    mockPrismaService.collectionRequest.findUnique.mockResolvedValue(mockRequest);

    await expect(service.verifyPin('req-1', 'collector-1', { pin: '9999' }))
      .rejects.toThrow(BadRequestException);
  });

  it('should reject verification of a non-ACCEPTED request', async () => {
    const mockRequest = {
      id: 'req-1',
      status: RequestStatus.PENDING,
      collectorId: 'collector-1',
      verificationPin: '1234',
    };

    mockPrismaService.collectionRequest.findUnique.mockResolvedValue(mockRequest);

    await expect(service.verifyPin('req-1', 'collector-1', { pin: '1234' }))
      .rejects.toThrow(BadRequestException);
  });
});
