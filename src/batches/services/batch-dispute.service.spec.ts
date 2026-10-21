import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { BatchDisputeService } from './batch-dispute.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('BatchDisputeService (PUCP Disoft - SRP & Domain Arbitration)', () => {
  let service: BatchDisputeService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      batch: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchDisputeService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BatchDisputeService>(BatchDisputeService);
  });

  describe('disputeBatch', () => {
    it('debe impugnar y transicionar a DISPUTED un lote en FLAGGED_FOR_REVIEW', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-d-1',
        collectorId: 'col-1',
        destinationCenterId: 'center-1',
        status: BatchStatus.FLAGGED_FOR_REVIEW,
      });

      mockPrisma.batch.update.mockResolvedValue({
        id: 'batch-d-1',
        status: 'DISPUTED',
      });

      const result = await service.disputeBatch('col-1', 'batch-d-1', {
        reason: 'El peso registrado en báscula no coincide con el pesado en origen.',
      });

      expect(result.status).toBe('DISPUTED');
      expect(mockPrisma.batch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'batch-d-1' },
          data: expect.objectContaining({ status: 'DISPUTED' }),
        }),
      );
    });

    it('debe rechazar la disputa si el usuario no es el recolector del lote', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-d-2',
        collectorId: 'other-collector',
        status: BatchStatus.FLAGGED_FOR_REVIEW,
      });

      await expect(
        service.disputeBatch('col-1', 'batch-d-2', { reason: 'Motivo válido de prueba' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('debe rechazar la disputa si el lote no está en FLAGGED_FOR_REVIEW', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-d-3',
        collectorId: 'col-1',
        status: BatchStatus.OPEN,
      });

      await expect(
        service.disputeBatch('col-1', 'batch-d-3', { reason: 'Motivo válido de prueba' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resolveDispute', () => {
    it('debe resolver la disputa administrativamente y actualizar a RECEIVED', async () => {
      mockPrisma.batch.findUnique.mockResolvedValue({
        id: 'batch-d-4',
        collectorId: 'col-1',
        status: 'DISPUTED',
      });

      mockPrisma.batch.update.mockResolvedValue({
        id: 'batch-d-4',
        status: BatchStatus.RECEIVED,
        hasDiscrepancy: false,
      });

      const result = await service.resolveDispute(
        'admin-1',
        'batch-d-4',
        { PET: 12.0 },
        'Acuerdo bilateral alcanzado tras calibración de balanza',
      );

      expect(result.status).toBe(BatchStatus.RECEIVED);
      expect(mockPrisma.batch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BatchStatus.RECEIVED,
            hasDiscrepancy: false,
          }),
        }),
      );
    });
  });
});
