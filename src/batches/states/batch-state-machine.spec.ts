import { ConflictException } from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { BatchStateMachine } from './batch-state-machine';

describe('Patrón Estado: BatchStateMachine (PUCP Disoft Diapositiva 06)', () => {
  it('debe permitir transiciones legales entre estados de un lote', () => {
    // OPEN -> IN_TRANSIT
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.OPEN,
        BatchStatus.IN_TRANSIT,
      ),
    ).not.toThrow();

    // IN_TRANSIT -> RECEIVED
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.IN_TRANSIT,
        BatchStatus.RECEIVED,
      ),
    ).not.toThrow();

    // RECEIVED -> CONSOLIDATED
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.RECEIVED,
        BatchStatus.CONSOLIDATED,
      ),
    ).not.toThrow();

    // PROCESSING -> FLAGGED_FOR_REVIEW
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.PROCESSING,
        BatchStatus.FLAGGED_FOR_REVIEW,
      ),
    ).not.toThrow();
  });

  it('debe rechazar con ConflictException transiciones prohibidas', () => {
    // Un lote CONSOLIDATED no puede volver a OPEN
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.CONSOLIDATED,
        BatchStatus.OPEN,
      ),
    ).toThrow(ConflictException);

    // Un lote OPEN no puede consolidarse directamente sin pesaje y recepción previa
    expect(() =>
      BatchStateMachine.validateTransition(
        BatchStatus.OPEN,
        BatchStatus.CONSOLIDATED,
      ),
    ).toThrow(ConflictException);
  });

  it('debe evaluar correctamente si un estado es terminal', () => {
    expect(BatchStateMachine.isTerminal(BatchStatus.CONSOLIDATED)).toBe(true);
    expect(BatchStateMachine.isTerminal(BatchStatus.OPEN)).toBe(false);
    expect(BatchStateMachine.isTerminal(BatchStatus.IN_TRANSIT)).toBe(false);
  });
});
