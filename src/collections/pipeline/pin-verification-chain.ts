import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { CollectionStateMachine } from '../states/collection-state-machine';

export interface IPinVerificationContext {
  id: string;
  collectorId: string;
  submittedPin: string;
  actualWeights?: Record<string, any>;
  collectionRequest: any;
  redisService?: any;
}

export interface IPinVerificationHandler {
  setNext(handler: IPinVerificationHandler): IPinVerificationHandler;
  handle(context: IPinVerificationContext): Promise<void>;
}

/**
 * Patrón Chain of Responsibility (Cadena de Responsabilidad) - PUCP Disoft Diapositiva 06
 * Descompone la validación de seguridad de verificación de PIN en una serie de eslabones independientes.
 */
export abstract class AbstractPinVerificationHandler
  implements IPinVerificationHandler
{
  private nextHandler: IPinVerificationHandler | null = null;

  public setNext(handler: IPinVerificationHandler): IPinVerificationHandler {
    this.nextHandler = handler;
    return handler;
  }

  public async handle(context: IPinVerificationContext): Promise<void> {
    await this.process(context);
    if (this.nextHandler) {
      await this.nextHandler.handle(context);
    }
  }

  protected abstract process(context: IPinVerificationContext): Promise<void>;
}

/**
 * Eslabón 1: Validación de Pertenencia del Recolector
 */
export class CollectorOwnershipStep extends AbstractPinVerificationHandler {
  protected async process(context: IPinVerificationContext): Promise<void> {
    if (context.collectionRequest.collectorId !== context.collectorId) {
      throw new ForbiddenException(
        'Únicamente el recolector que aceptó la solicitud puede verificar el PIN',
      );
    }
  }
}

/**
 * Eslabón 2: Validación del Estado Apto para Verificación
 */
export class StateReadinessStep extends AbstractPinVerificationHandler {
  protected async process(context: IPinVerificationContext): Promise<void> {
    if (!CollectionStateMachine.canVerifyPin(context.collectionRequest.status)) {
      throw new BadRequestException(
        'La solicitud debe estar en estado ACCEPTED, EN_ROUTE o ARRIVED para verificar el PIN',
      );
    }
  }
}

/**
 * Eslabón 3: Protección Anti-Fuerza Bruta en Redis
 */
export class BruteForceProtectionStep extends AbstractPinVerificationHandler {
  protected async process(context: IPinVerificationContext): Promise<void> {
    if (!context.redisService) return;

    const attemptsKey = `attempts:pin:${context.id}`;
    const attempts = await context.redisService.get(attemptsKey);
    if (attempts && parseInt(attempts, 10) >= 5) {
      throw new ForbiddenException(
        'Demasiados intentos fallidos de PIN. Esta verificación ha sido bloqueada temporalmente por seguridad (15 minutos).',
      );
    }
  }
}

/**
 * Eslabón 4: Coincidencia de PIN (Criptográfico y Hash en Memoria)
 */
export class PinMatchStep extends AbstractPinVerificationHandler {
  protected async process(context: IPinVerificationContext): Promise<void> {
    const { collectionRequest, submittedPin, redisService, id } = context;

    let isPinValid = collectionRequest.verificationPin === submittedPin;
    if (redisService) {
      const cachedPin = await redisService.get(`pin:collection:${id}`);
      if (cachedPin) {
        isPinValid = cachedPin === submittedPin;
      }
    }

    if (!isPinValid) {
      if (redisService) {
        const attemptsKey = `attempts:pin:${id}`;
        const rawAttempts = await redisService.get(attemptsKey);
        const count = (rawAttempts ? parseInt(rawAttempts, 10) : 0) + 1;
        await redisService.set(attemptsKey, count.toString(), 900);
        const remaining = Math.max(0, 5 - count);

        if (count >= 5) {
          throw new ForbiddenException(
            'Límite de 5 intentos fallidos de PIN alcanzado. Verificación bloqueada temporalmente por 15 minutos.',
          );
        }
        throw new BadRequestException(
          `PIN de verificación incorrecto. Te quedan ${remaining} intento(s) antes del bloqueo.`,
        );
      }
      throw new BadRequestException('PIN de verificación incorrecto o expirado');
    }

    // Limpieza de contadores tras éxito
    if (redisService) {
      await Promise.all([
        redisService.del(`pin:collection:${id}`).catch(() => {}),
        redisService.del(`attempts:pin:${id}`).catch(() => {}),
      ]);
    }
  }
}

/**
 * Eslabón 5: Validación de Pesos Reales Medidos
 */
export class WeightValidationStep extends AbstractPinVerificationHandler {
  protected async process(context: IPinVerificationContext): Promise<void> {
    const { actualWeights } = context;
    if (actualWeights && typeof actualWeights === 'object') {
      for (const [mat, weight] of Object.entries(actualWeights)) {
        const w = Number(weight);
        if (isNaN(w) || w < 0.5) {
          throw new BadRequestException(
            `El peso real ajustado para ${mat} debe ser de al menos 0.5 kg`,
          );
        }
        const parts = w.toString().split('.');
        if (parts.length > 1 && parts[1].length > 2) {
          throw new BadRequestException(
            `El peso real de ${mat} no puede tener más de 2 decimales`,
          );
        }
      }
    }
  }
}
