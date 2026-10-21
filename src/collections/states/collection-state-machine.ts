import { ConflictException, BadRequestException } from '@nestjs/common';
import { RequestStatus } from '@prisma/client';

/**
 * Patrón Estado (State Pattern) - PUCP Disoft Diapositiva 06
 * Encapsula las reglas formales de transición de estado en el ciclo de vida
 * de una solicitud de recolección, erradicando el código espagueti de condiciones dispersas.
 */
export class CollectionStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
    [RequestStatus.PENDING]: [
      RequestStatus.ACCEPTED,
      RequestStatus.CANCELLED,
      RequestStatus.UNATTENDED,
    ],
    [RequestStatus.AUCTION_ACTIVE]: [
      RequestStatus.AUCTION_ASSIGNED,
      RequestStatus.UNATTENDED,
      RequestStatus.CANCELLED,
    ],
    [RequestStatus.AUCTION_ASSIGNED]: [
      RequestStatus.ACCEPTED,
      RequestStatus.CANCELLED,
      RequestStatus.UNATTENDED,
    ],
    [RequestStatus.ACCEPTED]: [
      RequestStatus.EN_ROUTE,
      RequestStatus.PENDING, // Abandono por contingencia mecánica
      RequestStatus.CANCELLED,
      RequestStatus.REJECTED_ON_SITE,
      RequestStatus.COMPLETED,
    ],
    [RequestStatus.EN_ROUTE]: [
      RequestStatus.ARRIVED,
      RequestStatus.PENDING, // Abandono por contingencia mecánica
      RequestStatus.REJECTED_ON_SITE,
      RequestStatus.COMPLETED,
    ],
    [RequestStatus.ARRIVED]: [
      RequestStatus.COMPLETED,
      RequestStatus.REJECTED_ON_SITE,
      RequestStatus.CANCELLED,
    ],
    [RequestStatus.COMPLETED]: [],
    [RequestStatus.CANCELLED]: [],
    [RequestStatus.UNATTENDED]: [],
    [RequestStatus.REJECTED_ON_SITE]: [],
  };

  /**
   * Valida si una transición entre el estado actual y el estado destino es válida
   */
  public static validateTransition(
    currentStatus: RequestStatus,
    targetStatus: RequestStatus,
  ): void {
    if (currentStatus === targetStatus) {
      return; // No-op idempotente
    }

    const allowed = this.ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new ConflictException(
        `Transición inválida de estado: No se puede cambiar de '${currentStatus}' a '${targetStatus}'.`,
      );
    }
  }

  /**
   * Determina si la solicitud se encuentra en un estado activo modificable
   */
  public static isTerminal(status: RequestStatus): boolean {
    return (
      status === RequestStatus.COMPLETED ||
      status === RequestStatus.CANCELLED ||
      status === RequestStatus.UNATTENDED ||
      status === RequestStatus.REJECTED_ON_SITE
    );
  }

  /**
   * Valida si la solicitud se encuentra en estado apto para verificación de PIN en campo
   */
  public static canVerifyPin(status: RequestStatus): boolean {
    return (
      status === RequestStatus.ACCEPTED ||
      status === RequestStatus.EN_ROUTE ||
      status === RequestStatus.ARRIVED
    );
  }
}
