import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { IDomainEvent } from './domain-event.interface';

/**
 * Bus de Eventos de Dominio basado en el Patrón Observer (PUCP Disoft Diapositiva 06)
 * Utiliza RxJS Subject (patrón Observer/Observable clásico de GoF) para desacoplar
 * las transacciones de negocio de las notificaciones, analíticas y efectos secundarios.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly eventStream$ = new Subject<IDomainEvent>();

  /**
   * Publica un evento de dominio hacia todos los observadores registrados.
   */
  publish(event: IDomainEvent): void {
    this.logger.debug(
      `[DomainEventBus] Publicando evento: ${event.eventName} [Aggregate: ${event.aggregateId}]`,
    );
    this.eventStream$.next(event);
  }

  /**
   * Retorna un Observable filtrado por el nombre del evento.
   */
  ofType<T = any>(eventName: string): Observable<IDomainEvent<T>> {
    return this.eventStream$.asObservable().pipe(
      filter((e): e is IDomainEvent<T> => e.eventName === eventName),
    );
  }

  /**
   * Suscribe un observador a un tipo específico de evento de dominio.
   */
  subscribe<T = any>(
    eventName: string,
    handler: (event: IDomainEvent<T>) => Promise<void> | void,
  ): Subscription {
    return this.ofType<T>(eventName).subscribe({
      next: async (event) => {
        try {
          await handler(event);
        } catch (error: any) {
          this.logger.error(
            `[DomainEventBus] Error procesando suscriptor para ${eventName}: ${error.message}`,
          );
        }
      },
    });
  }
}
