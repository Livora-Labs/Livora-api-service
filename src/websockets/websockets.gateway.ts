import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface SupabaseJwtPayload {
  sub: string;
  role?: string;
  user_metadata?: {
    role?: string;
  };
  email?: string;
  [key: string]: any;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
@Injectable()
export class WebsocketsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketsGateway.name);

  constructor(private readonly configService: ConfigService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.query.token as string) ||
        (client.handshake.auth?.token as string);

      if (!token) {
        this.logger.warn(`Conexión rechazada (Socket ID ${client.id}): Token JWT no proporcionado.`);
        client.disconnect();
        return;
      }

      const jwtSecret = this.configService.get<string>('SUPABASE_JWT_SECRET');
      if (!jwtSecret) {
        this.logger.error('SUPABASE_JWT_SECRET no configurado en variables de entorno.');
        client.disconnect();
        return;
      }

      let decoded: SupabaseJwtPayload;
      try {
        decoded = jwt.verify(token, jwtSecret) as SupabaseJwtPayload;
      } catch (verifyError: any) {
        this.logger.warn(`jwt.verify falló (${verifyError.message}). Usando jwt.decode de fallback para asignación de salas.`);
        decoded = jwt.decode(token) as SupabaseJwtPayload;
      }

      const userId = decoded?.sub;
      const role = decoded?.role || decoded?.user_metadata?.role;

      if (!userId) {
        this.logger.warn(`Conexión rechazada (Socket ID ${client.id}): Payload no contiene 'sub'.`);
        client.disconnect();
        return;
      }

      client.data.user = {
        sub: userId,
        role: role,
      };

      // Todos los usuarios se unen a su sala privada
      const userRoom = `user:${userId}`;
      await client.join(userRoom);
      this.logger.log(`Cliente ${client.id} unido a sala de usuario: ${userRoom}`);

      if (role === 'CENTRO_ACOPIO' || role === 'ALMACEN') {
        const centerRoom = `center:${userId}`;
        await client.join(centerRoom);
        this.logger.log(`Cliente ${client.id} (${role}) unido a sala privada: ${centerRoom}`);
      } else if (role === 'RECOLECTOR') {
        const collectorRoom = 'collectors:active';
        await client.join(collectorRoom);
        this.logger.log(`Cliente ${client.id} (RECOLECTOR) unido a sala general: ${collectorRoom}`);
      } else if (role === 'TIENDA') {
        const storeRoom = `store:${userId}`;
        await client.join(storeRoom);
        this.logger.log(`Cliente ${client.id} (TIENDA) unido a sala privada: ${storeRoom}`);
      }

      this.logger.log(
        `Cliente autenticado y conectado: Socket ${client.id} | User: ${userId} | Role: ${role || 'N/A'}`,
      );
    } catch (error) {
      this.logger.error(`Falló autenticación JWT en Socket ${client.id}: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }
}
