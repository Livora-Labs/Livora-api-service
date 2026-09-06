import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BatchStatus, RequestStatus, Role } from '@prisma/client';
import { BatchesService } from './batches.service';
import { PrismaService } from '../prisma/prisma.service';

describe('BatchesService', () => {
  let service: BatchesService;
  let prismaMock: any;
  let queueMock: any;

  beforeEach(async () => {
    prismaMock = {
      batch: {
        findFirst: jest.fn(),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      collectionRequest: {
        updateMany: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
    };

    queueMock = {
      add: jest.fn().mockResolvedValue({ id: 'job-12345' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: 'BullQueue_blockchain-queue', useValue: queueMock },
      ],
    }).compile();

    service = module.get<BatchesService>(BatchesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOpenBatch', () => {
    it('should return all open batches for the collector', async () => {
      const mockBatches = [
        {
          id: 'batch-1',
          collectorId: 'collector-1',
          destinationCenterId: 'center-a',
          status: BatchStatus.OPEN,
          requests: [],
        },
        {
          id: 'batch-2',
          collectorId: 'collector-1',
          destinationCenterId: 'center-b',
          status: BatchStatus.OPEN,
          requests: [],
        },
      ];
      prismaMock.batch.findMany.mockResolvedValue(mockBatches);

      const result = await service.getOpenBatch('collector-1');

      expect(prismaMock.batch.findMany).toHaveBeenCalledWith({
        where: { collectorId: 'collector-1', status: BatchStatus.OPEN },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
      expect(result).toHaveLength(2);
      expect(result).toEqual(mockBatches);
    });

    it('should filter by centerId when provided', async () => {
      const mockBatches = [
        {
          id: 'batch-1',
          collectorId: 'collector-1',
          destinationCenterId: 'center-a',
          status: BatchStatus.OPEN,
          requests: [],
        },
      ];
      prismaMock.batch.findMany.mockResolvedValue(mockBatches);

      const result = await service.getOpenBatch('collector-1', 'center-a');

      expect(prismaMock.batch.findMany).toHaveBeenCalledWith({
        where: {
          collectorId: 'collector-1',
          destinationCenterId: 'center-a',
          status: BatchStatus.OPEN,
        },
        orderBy: { createdAt: 'desc' },
        include: expect.any(Object),
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('updateBatch', () => {
    it('should update batch to IN_TRANSIT with valid destinationCenterId', async () => {
      const existingBatch = {
        id: 'batch-1',
        collectorId: 'collector-1',
        status: BatchStatus.OPEN,
      };
      prismaMock.batch.findUnique.mockResolvedValue(existingBatch);
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'center-1',
        role: Role.CENTRO_ACOPIO,
      });
      prismaMock.batch.update.mockResolvedValue({
        ...existingBatch,
        status: BatchStatus.IN_TRANSIT,
        destinationCenterId: 'center-1',
      });

      const result = await service.updateBatch('batch-1', 'collector-1', {
        destinationCenterId: 'center-1',
      });

      expect(result.status).toBe(BatchStatus.IN_TRANSIT);
      expect(prismaMock.batch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: {
          destinationCenterId: 'center-1',
          status: BatchStatus.IN_TRANSIT,
        },
        include: {
          requests: true,
          destinationCenter: { select: { id: true, email: true } },
        },
      });
    });

    it('should throw ForbiddenException if collectorId does not match', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-1',
        collectorId: 'other-collector',
        status: BatchStatus.OPEN,
      });

      await expect(
        service.updateBatch('batch-1', 'collector-1', {
          destinationCenterId: 'center-1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if batch status is not OPEN', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-1',
        collectorId: 'collector-1',
        status: BatchStatus.IN_TRANSIT,
      });

      await expect(
        service.updateBatch('batch-1', 'collector-1', {
          destinationCenterId: 'center-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('receiveBatch', () => {
    it('should receive batch without discrepancy, update status to PROCESSING, add queue job and return HTTP 202 payload', async () => {
      const mockBatch = {
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.IN_TRANSIT,
        requests: [
          { householdId: 'h-1', itemsEstimated: { PET: 25.0 } },
          { householdId: 'h-2', itemsEstimated: { HDPE: 10.0 } },
        ],
      };

      prismaMock.batch.findUnique.mockResolvedValue(mockBatch);
      prismaMock.batch.update.mockResolvedValue({
        ...mockBatch,
        status: BatchStatus.PROCESSING,
      });

      const materials = { PET: 25.5, HDPE: 10.0 };
      const response = await service.receiveBatch('batch-1', 'center-1', {
        materialsActual: materials,
      });

      expect(response).toEqual({
        status: BatchStatus.PROCESSING,
        batchId: 'batch-1',
        transactionJobId: 'job-12345',
      });
      expect(queueMock.add).toHaveBeenCalledWith(
        'process-batch-blockchain',
        expect.objectContaining({
          batchId: 'batch-1',
          collectorId: 'collector-1',
          centerId: 'center-1',
          materialsActual: materials,
          householdIds: ['h-1', 'h-2'],
          correlationId: expect.any(String),
        }),
        {
          jobId: 'batch-batch-1',
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );
    });

    it('should flag batch as FLAGGED_FOR_REVIEW and not queue blockchain job when weight discrepancy exceeds 15%', async () => {
      const mockBatch = {
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.IN_TRANSIT,
        requests: [
          { householdId: 'h-1', itemsEstimated: { PET: 10.0 } },
        ],
      };

      prismaMock.batch.findUnique.mockResolvedValue(mockBatch);
      prismaMock.batch.update.mockResolvedValue({
        ...mockBatch,
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        hasDiscrepancy: true,
      });

      queueMock.add.mockClear();

      // Estimated is 10.0 kg, actual is 20.0 kg (100% discrepancy > 15%)
      const response = await service.receiveBatch('batch-1', 'center-1', {
        materialsActual: { PET: 20.0 },
      });

      expect(response.status).toBe(BatchStatus.FLAGGED_FOR_REVIEW);
      expect(response.hasDiscrepancy).toBe(true);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should throw ConflictException (HTTP 409) if batch is already PROCESSING or RECEIVED', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.PROCESSING,
        requests: [],
      });

      await expect(
        service.receiveBatch('batch-1', 'center-1', {
          materialsActual: { PET: 10 },
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should receive batch successfully when batch status is OPEN as operational resilience', async () => {
      const mockBatch = {
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.OPEN,
        requests: [
          { householdId: 'h-1', itemsEstimated: { PET: 10.0 } },
        ],
      };

      prismaMock.batch.findUnique.mockResolvedValue(mockBatch);
      prismaMock.batch.update.mockResolvedValue({
        ...mockBatch,
        status: BatchStatus.PROCESSING,
      });

      const response = await service.receiveBatch('batch-1', 'center-1', {
        materialsActual: { PET: 10.0 },
      });

      expect(response.status).toBe(BatchStatus.PROCESSING);
      expect(queueMock.add).toHaveBeenCalled();
    });

    it('should throw ForbiddenException if centerId does not match destinationCenterId', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'other-center',
        status: BatchStatus.IN_TRANSIT,
        requests: [],
      });

      await expect(
        service.receiveBatch('batch-1', 'center-1', {
          materialsActual: { PET: 10 },
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('approveFlaggedBatch', () => {
    it('should approve FLAGGED_FOR_REVIEW batch and dispatch to blockchain queue', async () => {
      const mockBatch = {
        id: 'batch-flagged',
        collectorId: 'col-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        materialsActual: { PET: 25.0 },
        requests: [{ householdId: 'h-1' }],
      };

      prismaMock.batch.findUnique.mockResolvedValue(mockBatch);
      prismaMock.batch.update.mockResolvedValue({
        ...mockBatch,
        status: BatchStatus.PROCESSING,
      });

      const res = await service.approveFlaggedBatch('batch-flagged', 'admin-user-id');

      expect(res.status).toBe(BatchStatus.PROCESSING);
      expect(queueMock.add).toHaveBeenCalled();
    });

    it('should throw BadRequestException if batch is not FLAGGED_FOR_REVIEW', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-open',
        status: BatchStatus.OPEN,
        requests: [],
      });

      await expect(
        service.approveFlaggedBatch('batch-open', 'admin-id'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
