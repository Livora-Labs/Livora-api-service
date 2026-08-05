import { Injectable, Logger } from '@nestjs/common';
import { WebsocketsGateway } from './websockets.gateway';

@Injectable()
export class WebsocketsService {
  private readonly logger = new Logger(WebsocketsService.name);

  constructor(private readonly websocketsGateway: WebsocketsGateway) {}

  /**
   * Emite el evento 'collection:created' a la sala 'collectors:active'
   * @param payload Datos de la recolección creada
   */
  emitCollectionCreated(payload: any): void {
    this.logger.log(`Emitiendo evento 'collection:created' a la sala 'collectors:active'`);
    this.websocketsGateway.server
      .to('collectors:active')
      .emit('collection:created', payload);
  }

  /**
   * Emite el evento 'batch:completed' a la sala privada del centro de acopio 'center:${centerId}'
   * @param centerId ID del Centro de Acopio destino
   * @param payload Datos del lote finalizado
   */
  emitBatchCompleted(centerId: string, payload: any): void {
    const room = `center:${centerId}`;
    this.logger.log(`Emitiendo evento 'batch:completed' a la sala '${room}'`);
    this.websocketsGateway.server.to(room).emit('batch:completed', payload);
  }
}
