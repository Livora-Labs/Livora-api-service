import { DomainEventBus } from './domain-event-bus';
import {
  CollectionCreatedEvent,
  CollectionStatusChangedEvent,
  BatchReceivedEvent,
  BatchDisputedEvent,
} from './domain-event.interface';

describe('DomainEventBus (PUCP Disoft - Observer Pattern)', () => {
  let eventBus: DomainEventBus;

  beforeEach(() => {
    eventBus = new DomainEventBus();
  });

  it('debe notificar al observador cuando se emite un CollectionCreatedEvent', (done) => {
    const event = new CollectionCreatedEvent('req-123', {
      requestId: 'req-123',
      householdId: 'user-hogar-1',
      assignmentMode: 'AUTOMATIC',
    });

    eventBus.subscribe<any>('collection.created', (emitted) => {
      expect(emitted.eventName).toBe('collection.created');
      expect(emitted.aggregateId).toBe('req-123');
      expect(emitted.payload.householdId).toBe('user-hogar-1');
      expect(emitted.occurredOn).toBeInstanceOf(Date);
      done();
    });

    eventBus.publish(event);
  });

  it('debe filtrar y no recibir eventos de otros tipos suscritos', (done) => {
    const receivedOtherEvents: string[] = [];

    eventBus.subscribe('batch.received', (emitted) => {
      receivedOtherEvents.push(emitted.eventName);
    });

    const statusEvent = new CollectionStatusChangedEvent('req-456', {
      previousStatus: 'ACCEPTED',
      newStatus: 'EN_ROUTE',
      userId: 'collector-1',
    });

    eventBus.publish(statusEvent);

    setTimeout(() => {
      expect(receivedOtherEvents).toHaveLength(0);
      done();
    }, 50);
  });

  it('debe permitir múltiples observadores simultáneos para un mismo evento (1 a N)', (done) => {
    let observer1Notified = false;
    let observer2Notified = false;

    const event = new BatchReceivedEvent('batch-999', {
      batchId: 'batch-999',
      centerId: 'center-1',
      totalKg: 85.5,
      hasDiscrepancy: false,
    });

    eventBus.subscribe('batch.received', () => {
      observer1Notified = true;
      if (observer1Notified && observer2Notified) done();
    });

    eventBus.subscribe('batch.received', () => {
      observer2Notified = true;
      if (observer1Notified && observer2Notified) done();
    });

    eventBus.publish(event);
  });

  it('debe manejar errores en un observador sin interrumpir el flujo', (done) => {
    const failingObserver = jest.fn().mockImplementation(() => {
      throw new Error('Unexpected observer error');
    });

    eventBus.subscribe('batch.disputed', failingObserver);

    const successfulObserver = jest.fn().mockImplementation((e) => {
      expect(e.aggregateId).toBe('batch-disputed-1');
      done();
    });

    eventBus.subscribe('batch.disputed', successfulObserver);

    const disputeEvent = new BatchDisputedEvent('batch-disputed-1', {
      batchId: 'batch-disputed-1',
      collectorId: 'collector-5',
      reason: 'Discrepancia de pesaje en tolva industrial',
    });

    eventBus.publish(disputeEvent);
  });
});
