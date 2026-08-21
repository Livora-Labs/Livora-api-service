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
    it('should return existing OPEN batch and associate unbatched accepted requests', async () => {
      const mockBatch = {
        id: 'batch-uuid',
        collectorId: 'collector-1',
        status: BatchStatus.OPEN,
        requests: [],
      };
      prismaMock.batch.findFirst.mockResolvedValue(mockBatch);
      prismaMock.batch.findUnique.mockResolvedValue({
        ...mockBatch,
        requests: [],
      });

      const result = await service.getOpenBatch('collector-1');

      expect(prismaMock.batch.findFirst).toHaveBeenCalledWith({
        where: { collectorId: 'collector-1', status: BatchStatus.OPEN },
        include: { requests: true },
      });
      expect(prismaMock.collectionRequest.updateMany).toHaveBeenCalledWith({
        where: {
          collectorId: 'collector-1',
          status: RequestStatus.ACCEPTED,
          batchId: null,
        },
        data: { batchId: 'batch-uuid' },
      });
      expect(result).toBeDefined();
    });

    it('should create new OPEN batch if none exists', async () => {
      const createdBatch = {
        id: 'new-batch-uuid',
        collectorId: 'collector-1',
        status: BatchStatus.OPEN,
        requests: [],
      };
      prismaMock.batch.findFirst.mockResolvedValue(null);
      prismaMock.batch.create.mockResolvedValue(createdBatch);
      prismaMock.batch.findUnique.mockResolvedValue(createdBatch);

      const result = await service.getOpenBatch('collector-1');

      expect(prismaMock.batch.create).toHaveBeenCalledWith({
        data: { collectorId: 'collector-1', status: BatchStatus.OPEN },
        include: { requests: true },
      });
      expect(result).toBeDefined();
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
    it('should receive batch, update status to PROCESSING, add queue job and return HTTP 202 payload', async () => {
      const mockBatch = {
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.IN_TRANSIT,
        requests: [{ householdId: 'h-1' }, { householdId: 'h-2' }],
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
        {
          batchId: 'batch-1',
          collectorId: 'collector-1',
          centerId: 'center-1',
          materialsActual: materials,
          householdIds: ['h-1', 'h-2'],
        },
        {
          jobId: 'batch-batch-1',
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      );
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

    it('should throw BadRequestException if batch status is OPEN instead of IN_TRANSIT', async () => {
      prismaMock.batch.findUnique.mockResolvedValue({
        id: 'batch-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.OPEN,
        requests: [],
      });

      await expect(
        service.receiveBatch('batch-1', 'center-1', {
          materialsActual: { PET: 10 },
        }),
      ).rejects.toThrow(BadRequestException);
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
});
