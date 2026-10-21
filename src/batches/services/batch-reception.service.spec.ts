import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { BatchReceptionService } from './batch-reception.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('BatchReceptionService (PUCP Disoft - SRP & Antipattern Elimination)', () => {
  let service: BatchReceptionService;
  let mockPrisma: any;
  let mockQueue: any;

  beforeEach(async () => {
    mockPrisma = {
      batch: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-xyz-123' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchReceptionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: 'BullQueue_blockchain-queue', useValue: mockQueue },
      ],
    }).compile();

    service = module.get<BatchReceptionService>(BatchReceptionService);
  });

  describe('receiveBatch', () => {
    it('debe recibir el lote y despachar a BullMQ cuando el pesaje está dentro del ±15%', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-rec-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.IN_TRANSIT,
        requests: [
          { householdId: 'h-1', itemsEstimated: { PET: 10.0 } },
          { householdId: 'h-2', itemsEstimated: { CARTON: 5.0 } },
        ],
      });

      mockPrisma.batch.update.mockResolvedValue({
        id: 'batch-rec-1',
        collectorId: 'collector-1',
        status: BatchStatus.PROCESSING,
        materialsActual: { PET: 10.5, CARTON: 4.8 },
      });

      const result = await service.receiveBatch('batch-rec-1', 'center-1', {
        materialsActual: { PET: 10.5, CARTON: 4.8 },
      });

      expect(result.status).toBe(BatchStatus.PROCESSING);
      expect(result.transactionJobId).toBe('job-xyz-123');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-batch-blockchain',
        expect.objectContaining({
          batchId: 'batch-rec-1',
          collectorId: 'collector-1',
          centerId: 'center-1',
        }),
        expect.any(Object),
      );
    });

    it('debe retener en FLAGGED_FOR_REVIEW si la discrepancia excede el 15%', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-rec-2',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.IN_TRANSIT,
        requests: [{ householdId: 'h-1', itemsEstimated: { PET: 10.0 } }],
      });

      mockPrisma.batch.update.mockResolvedValue({
        id: 'batch-rec-2',
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        hasDiscrepancy: true,
      });

      const result = await service.receiveBatch('batch-rec-2', 'center-1', {
        materialsActual: { PET: 25.0 }, // 150% de incremento > 15%
      });

      expect(result.status).toBe(BatchStatus.FLAGGED_FOR_REVIEW);
      expect(result.hasDiscrepancy).toBe(true);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('debe lanzar ConflictException si el lote ya fue recibido o está en procesamiento', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-rec-3',
        status: BatchStatus.PROCESSING,
      });

      await expect(
        service.receiveBatch('batch-rec-3', 'center-1', { materialsActual: { PET: 5 } }),
      ).rejects.toThrow(ConflictException);
    });

    it('debe lanzar ForbiddenException si el destinationCenterId no coincide', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-rec-4',
        destinationCenterId: 'other-center',
        status: BatchStatus.IN_TRANSIT,
        requests: [],
      });

      await expect(
        service.receiveBatch('batch-rec-4', 'center-1', { materialsActual: { PET: 5 } }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('approveFlaggedBatch', () => {
    it('debe aprobar manualmente un lote retenido y despacharlo a la cola blockchain', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-flagged-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.FLAGGED_FOR_REVIEW,
        materialsActual: { PET: 30.0 },
        requests: [{ householdId: 'h-1' }],
      });

      mockPrisma.batch.update.mockResolvedValue({
        id: 'batch-flagged-1',
        collectorId: 'collector-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.PROCESSING,
        materialsActual: { PET: 30.0 },
      });

      const res = await service.approveFlaggedBatch('batch-flagged-1', 'admin-id', 'Tolerancia industrial justificada');

      expect(res.status).toBe(BatchStatus.PROCESSING);
      expect(mockQueue.add).toHaveBeenCalled();
    });
  });
});
