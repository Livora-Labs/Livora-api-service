import { ConflictException } from '@nestjs/common';
import { BatchStatus } from '@prisma/client';

/**
 * Patrón Estado (State Pattern) para Lotes de Reciclaje - PUCP Disoft Diapositiva 06
 * Gobierna las transiciones formales entre estados en el ciclo de vida de un lote (Batch),
 * previniendo inconsistencias operativas y garantizando trazabilidad y auditoría.
 */
export class BatchStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
    [BatchStatus.OPEN]: [
      BatchStatus.IN_TRANSIT,
      BatchStatus.PROCESSING,
      BatchStatus.RECEIVED,
      BatchStatus.FLAGGED_FOR_REVIEW,
    ],
    [BatchStatus.IN_TRANSIT]: [
      BatchStatus.PROCESSING,
      BatchStatus.RECEIVED,
      BatchStatus.REROUTED,
      BatchStatus.FLAGGED_FOR_REVIEW,
    ],
    [BatchStatus.PROCESSING]: [
      BatchStatus.RECEIVED,
      BatchStatus.PARTIALLY_ACCEPTED,
      BatchStatus.FLAGGED_FOR_REVIEW,
      BatchStatus.DISPUTED,
    ],
    [BatchStatus.FLAGGED_FOR_REVIEW]: [
      BatchStatus.RECEIVED,
      BatchStatus.DISPUTED,
      BatchStatus.PARTIALLY_ACCEPTED,
    ],
    [BatchStatus.DISPUTED]: [
      BatchStatus.RECEIVED,
      BatchStatus.PARTIALLY_ACCEPTED,
      BatchStatus.REROUTED,
    ],
    [BatchStatus.RECEIVED]: [
      BatchStatus.CONSOLIDATED,
    ],
    [BatchStatus.PARTIALLY_ACCEPTED]: [
      BatchStatus.CONSOLIDATED,
    ],
    [BatchStatus.REROUTED]: [
      BatchStatus.OPEN,
      BatchStatus.IN_TRANSIT,
    ],
    [BatchStatus.CONSOLIDATED]: [],
  };

  /**
   * Valida si la transición solicitada es legal según la máquina de estados
   */
  public static validateTransition(
    currentStatus: BatchStatus,
    targetStatus: BatchStatus,
  ): void {
    if (currentStatus === targetStatus) return;

    const allowed = this.ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new ConflictException(
        `Transición inválida de estado en Lote: No se puede cambiar de '${currentStatus}' a '${targetStatus}'.`,
      );
    }
  }

  /**
   * Indica si un lote ya está consolidado o en estado terminal
   */
  public static isTerminal(status: BatchStatus): boolean {
    return status === BatchStatus.CONSOLIDATED;
  }
}
