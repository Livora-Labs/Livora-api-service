/**
 * Interfaz base para Eventos de Dominio (PUCP Disoft Diapositiva 06 - Patrón Observer)
 * Representa un hecho significativo e inmutable que ocurrió en el dominio del negocio.
 */
export interface IDomainEvent<T = any> {
  readonly eventName: string;
  readonly aggregateId: string;
  readonly occurredOn: Date;
  readonly payload: T;
}

/**
 * Evento emitido cuando se crea una nueva solicitud de recolección en domicilio.
 */
export class CollectionCreatedEvent implements IDomainEvent<{ requestId: string; householdId: string; assignmentMode: string }> {
  readonly eventName = 'collection.created';
  readonly occurredOn: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: { requestId: string; householdId: string; assignmentMode: string },
  ) {
    this.occurredOn = new Date();
  }
}

/**
 * Evento emitido cuando el estado de una solicitud de recolección cambia en la máquina de estados.
 */
export class CollectionStatusChangedEvent implements IDomainEvent<{ previousStatus: string; newStatus: string; userId: string }> {
  readonly eventName = 'collection.status-changed';
  readonly occurredOn: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: { previousStatus: string; newStatus: string; userId: string },
  ) {
    this.occurredOn = new Date();
  }
}

/**
 * Evento emitido cuando un centro de acopio recibe y pesa físicamente un lote de reciclaje.
 */
export class BatchReceivedEvent implements IDomainEvent<{ batchId: string; centerId: string; totalKg: number; hasDiscrepancy: boolean }> {
  readonly eventName = 'batch.received';
  readonly occurredOn: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: { batchId: string; centerId: string; totalKg: number; hasDiscrepancy: boolean },
  ) {
    this.occurredOn = new Date();
  }
}

/**
 * Evento emitido cuando un recolector impugna el pesaje de un lote observado.
 */
export class BatchDisputedEvent implements IDomainEvent<{ batchId: string; collectorId: string; reason: string }> {
  readonly eventName = 'batch.disputed';
  readonly occurredOn: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: { batchId: string; collectorId: string; reason: string },
  ) {
    this.occurredOn = new Date();
  }
}
