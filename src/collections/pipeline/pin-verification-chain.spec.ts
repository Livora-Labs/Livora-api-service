import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { RequestStatus } from '@prisma/client';
import {
  CollectorOwnershipStep,
  StateReadinessStep,
  BruteForceProtectionStep,
  PinMatchStep,
  WeightValidationStep,
} from './pin-verification-chain';

describe('Patrón Cadena de Responsabilidad: PinVerificationChain (PUCP Disoft Diapositiva 06)', () => {
  describe('CollectorOwnershipStep', () => {
    const step = new CollectorOwnershipStep();

    it('debe permitir continuar si el recolector asignado coincide', async () => {
      const context: any = {
        collectorId: 'collector-123',
        collectionRequest: { collectorId: 'collector-123' },
      };
      await expect(step.handle(context)).resolves.not.toThrow();
    });

    it('debe lanzar ForbiddenException si otro recolector intenta verificar', async () => {
      const context: any = {
        collectorId: 'collector-hacker',
        collectionRequest: { collectorId: 'collector-legit' },
      };
      await expect(step.handle(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('StateReadinessStep', () => {
    const step = new StateReadinessStep();

    it('debe permitir continuar si el estado es ACCEPTED, EN_ROUTE o ARRIVED', async () => {
      for (const status of [
        RequestStatus.ACCEPTED,
        RequestStatus.EN_ROUTE,
        RequestStatus.ARRIVED,
      ]) {
        await expect(
          step.handle({ collectionRequest: { status } } as any),
        ).resolves.not.toThrow();
      }
    });

    it('debe lanzar BadRequestException si el estado es PENDING o COMPLETED', async () => {
      await expect(
        step.handle({ collectionRequest: { status: RequestStatus.PENDING } } as any),
      ).rejects.toThrow(BadRequestException);

      await expect(
        step.handle({ collectionRequest: { status: RequestStatus.COMPLETED } } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('BruteForceProtectionStep', () => {
    const step = new BruteForceProtectionStep();

    it('debe bloquear con ForbiddenException si los intentos fallidos alcanzan 5', async () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue('5'),
      };
      const context: any = {
        id: 'req-001',
        redisService: mockRedis,
      };

      await expect(step.handle(context)).rejects.toThrow(ForbiddenException);
    });

    it('debe permitir continuar si los intentos son menores a 5', async () => {
      const mockRedis = {
        get: jest.fn().mockResolvedValue('2'),
      };
      const context: any = {
        id: 'req-001',
        redisService: mockRedis,
      };

      await expect(step.handle(context)).resolves.not.toThrow();
    });
  });

  describe('WeightValidationStep', () => {
    const step = new WeightValidationStep();

    it('debe validar que los pesos sean mayores a 0.5 kg y máximo 2 decimales', async () => {
      const validContext: any = {
        actualWeights: { PLASTIC: 2.55, METAL: 10.0 },
      };
      await expect(step.handle(validContext)).resolves.not.toThrow();
    });

    it('debe lanzar BadRequestException si un peso es menor a 0.5 kg', async () => {
      const invalidContext: any = {
        actualWeights: { PLASTIC: 0.2 },
      };
      await expect(step.handle(invalidContext)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('debe lanzar BadRequestException si un peso tiene más de 2 decimales', async () => {
      const invalidContext: any = {
        actualWeights: { PLASTIC: 1.234 },
      };
      await expect(step.handle(invalidContext)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
