import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.query.token as string) ||
        (client.handshake.auth?.token as string);

      if (!token) {
        this.logger.warn(
          `Conexión rechazada (Socket ${client.id}): token JWT no proporcionado.`,
        );
        client.disconnect();
        return;
      }

      // Validación REMOTA contra Supabase (soporta tokens ES256 asimétricos con
      // `kid`, que es lo que Supabase emite hoy). Es el mismo método que usa el
      // guard HTTP; `jwt.verify` con secreto HS256 fallaba siempre con ES256.
      const { data, error } = await this.supabaseService
        .getClient()
        .auth.getUser(token);

      if (error || !data.user) {
        this.logger.warn(
          `Conexión rechazada (Socket ${client.id}): token inválido (${error?.message || 'sin usuario'}).`,
        );
        client.disconnect();
        return;
      }

      const userId = data.user.id;

      // El rol de la app (HOGAR/RECOLECTOR/...) vive en PostgreSQL, NO en el JWT
      // de Supabase. Se consulta la BD como fuente de verdad para las salas.
      const dbUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const role = dbUser?.role || null;

      client.data.user = { sub: userId, role };

      // Todos entran a su sala privada
      await client.join(`user:${userId}`);

      if (role === 'CENTRO_ACOPIO' || role === 'ALMACEN') {
        await client.join(`center:${userId}`);
      } else if (role === 'RECOLECTOR') {
        await client.join('collectors:active');
      } else if (role === 'TIENDA') {
        await client.join(`store:${userId}`);
      }

      // Ack de confirmación con el rol y las salas asignadas
      client.emit('connected', { userId, role });

      this.logger.log(
        `Cliente conectado: Socket ${client.id} | User ${userId} | Role ${role || 'N/A'}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falló autenticación en Socket ${client.id}: ${err.message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }
}
