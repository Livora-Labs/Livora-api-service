import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './events/domain-event-bus';

/**
 * Módulo Global Común (PUCP Disoft)
 * Exporta servicios transversales como el Bus de Eventos de Dominio (Patrón Observer).
 */
@Global()
@Module({
  providers: [DomainEventBus],
  exports: [DomainEventBus],
})
export class CommonModule {}
