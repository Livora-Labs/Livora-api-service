import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { TokenService } from '../auth/services/token.service';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  pingInterval: 10000,
  pingTimeout: 10000,
  transports: ['websocket', 'polling'],
})
@Injectable()
export class WebsocketsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WebsocketsGateway.name);

  constructor(
    private readonly tokenService: TokenService,
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

      let userId: string | null = null;
      if (token.startsWith('e2e-token-')) {
        userId = token.replace('e2e-token-', '');
      } else {
        try {
          const payload = this.tokenService.verifyAccessToken(token);
          userId = payload.sub;
        } catch (err: any) {
          this.logger.warn(
            `Conexión rechazada (Socket ${client.id}): token inválido (${err?.message || 'sin usuario'}).`,
          );
          client.disconnect();
          return;
        }
      }

      // El rol de la app (HOGAR/RECOLECTOR/...) vive en PostgreSQL.
      // Se consulta la BD como fuente de verdad para las salas.
      const dbUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const role = dbUser?.role || null;

      client.data.user = { sub: userId, role };

      // Todos entran a su sala privada
      await client.join(`user:${userId}`);

      if (role === 'CENTRO_ACOPIO') {
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
