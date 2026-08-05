# Especificación Técnica y Arquitectura: Módulo de WebSockets (`WebsocketsModule`)

**Proyecto:** ArbiTrust Backend (NestJS Monorepo)  
**Versión:** 1.0.0  
**Ubicación del Documento:** `docs/specs/04-websockets-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen y Propósito del Módulo

El **Módulo de WebSockets (`WebsocketsModule`)** es el componente de comunicación bidireccional en tiempo real de ArbiTrust. Este módulo habilita capacidades interactivas distribuidas para la plataforma, respondiendo a dos necesidades operativas clave:

1. **Mapa Dinámico y Difusión para Recolectores (`collectors:active`)**: Notifica instantáneamente a los recolectores activos en campo cuando un hogar crea una nueva solicitud de recolección (`collection:created`), alimentando el mapa en tiempo real y la asignación de rutas.
2. **Notificaciones Asíncronas para Centros de Acopio (`center:${userId}`)**: Envía alertas privadas en tiempo real a la interfaz del centro de acopio cuando un lote de residuos ha sido procesado o completado por el worker de blockchain (`batch:completed`), eliminando la necesidad de sondeo (polling) HTTP.

```
       [ HOGARES ] ──► (Nueva Recolección)
                            │
                            ▼
                  [ CollectionsModule ]
                            │
                            ▼
                  [ WebsocketsService ]
                            │
            (emitCollectionCreated)
                            │
                            ▼
               [ Room: 'collectors:active' ] ──► [ RECOLECTORES (Sockets) ]

-------------------------------------------------------------------------

       [ WORKER / BATCHES ] ──► (Lote Procesado)
                                    │
                                    ▼
                          [ WebsocketsService ]
                                    │
                            (emitBatchCompleted)
                                    │
                                    ▼
                      [ Room: 'center:${userId}' ] ──► [ CENTRO ACOPIO (Socket) ]
```

---

## 2. Arquitectura del Adaptador de Redis (`redis-io.adapter.ts`)

Para permitir la **escalabilidad horizontal** del Gateway de Socket.io en infraestructuras distribuidas (múltiples réplicas de la API en producción), se implementó un adaptador personalizado basado en Redis Pub/Sub.

### 1. Extensión de `IoAdapter`
El adaptador [`RedisIoAdapter`](file:///c:/Users/Acer/Desktop/Estudio/Proyectos/ArbiTrust/src/websockets/adapters/redis-io.adapter.ts) extiende de `IoAdapter` (`@nestjs/platform-socket.io`).

```typescript
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(
    appOrHttpServer: INestApplicationContext,
    private readonly configService: ConfigService,
  ) {
    super(appOrHttpServer);
  }
}
```

### 2. Clientes Independientes de `ioredis` (`pubClient` y `subClient`)
Socket.io requiere dos conexiones independientes con Redis: una para publicar eventos (`pubClient`) y otra para suscribirse a canales (`subClient`). Dado que un cliente en modo suscripción no puede procesar comandos ordinarios, `subClient` se crea duplicando `pubClient`:

```typescript
async connectToRedis(): Promise<void> {
  const host = this.configService.get<string>('REDIS_HOST', 'localhost');
  const port = this.configService.get<number>('REDIS_PORT', 6379);

  const pubClient = new Redis({ host, port });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => {
    this.logger.error(`Error en Redis Pub Client: ${err.message}`);
  });

  subClient.on('error', (err) => {
    this.logger.error(`Error en Redis Sub Client: ${err.message}`);
  });

  this.adapterConstructor = createAdapter(pubClient, subClient);
  this.logger.log(`RedisIoAdapter conectado exitosamente a Redis en ${host}:${port}`);
}
```

### 3. Registro Global en `main.ts`
El adaptador se conecta a Redis e inicializa globalmente antes de levantar la aplicación HTTP en [`main.ts`](file:///c:/Users/Acer/Desktop/Estudio/Proyectos/ArbiTrust/src/main.ts):

```typescript
const configService = app.get(ConfigService);
const redisIoAdapter = new RedisIoAdapter(app, configService);
await redisIoAdapter.connectToRedis();
app.useWebSocketAdapter(redisIoAdapter);
```

---

## 3. Seguridad y Autenticación en el Handshake (`websockets.gateway.ts`)

La autenticación se realiza de manera síncrona durante el **handshake inicial** de la conexión Socket.io en [`WebsocketsGateway`](file:///c:/Users/Acer/Desktop/Estudio/Proyectos/ArbiTrust/src/websockets/websockets.gateway.ts).

### Flujo de Validación JWT

1. **Extracción del Token**: Se obtiene el JWT desde `client.handshake.query.token` (con fallback defensivo a `client.handshake.auth?.token`).
2. **Verificación Criptográfica**: Se valida la firma y expiración del JWT contra la clave secreta `SUPABASE_JWT_SECRET` utilizando la librería `jsonwebtoken`.
3. **Blindaje contra Conexiones Anónimas**: Si el token no está presente, es inválido, ha expirado o no contiene el claim `sub` (ID de usuario), el servidor ejecuta inmediatamente `client.disconnect()` rechazando la conexión antes de cualquier intercambio de datos.
4. **Contexto de Sesión (`client.data.user`)**: Si la validación es exitosa, se almacena el payload decodificado en `client.data.user`:
   ```typescript
   client.data.user = {
     sub: userId,
     role: role,
   };
   ```

```typescript
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
    const decoded = jwt.verify(token, jwtSecret) as SupabaseJwtPayload;

    const userId = decoded.sub;
    const role = decoded.role || decoded.user_metadata?.role;

    if (!userId) {
      client.disconnect();
      return;
    }

    client.data.user = { sub: userId, role };
    // ... gestión de salas
  } catch (error) {
    this.logger.error(`Falló autenticación JWT en Socket ${client.id}: ${error.message}`);
    client.disconnect();
  }
}
```

---

## 4. Gestión Dinámica de Salas (Rooms)

Al completar la autenticación en `handleConnection`, el gateway analiza el rol del usuario (`client.data.user.role`) y une el socket automáticamente a las salas correspondientes:

- **Rol `CENTRO_ACOPIO`**: Se une dinámicamente a la sala privada:
  $$\text{Sala Privada} = \text{center:\{userId\}}$$
  *Propósito*: Recibir notificaciones exclusivas sobre lotes finalizados destinados a su instalación.

- **Rol `RECOLECTOR`**: Se une a la sala pública general:
  $$\text{Sala Difusión} = \text{collectors:active}$$
  *Propósito*: Recibir notificaciones en vivo sobre nuevas solicitudes de recolección creadas en la plataforma.

```typescript
if (role === 'CENTRO_ACOPIO') {
  const centerRoom = `center:${userId}`;
  await client.join(centerRoom);
  this.logger.log(`Cliente ${client.id} (CENTRO_ACOPIO) unido a sala privada: ${centerRoom}`);
} else if (role === 'RECOLECTOR') {
  const collectorRoom = 'collectors:active';
  await client.join(collectorRoom);
  this.logger.log(`Cliente ${client.id} (RECOLECTOR) unido a sala general: ${collectorRoom}`);
}
```

---

## 5. Servicio de Emisión de Eventos (`websockets.service.ts`)

El servicio [`WebsocketsService`](file:///c:/Users/Acer/Desktop/Estudio/Proyectos/ArbiTrust/src/websockets/websockets.service.ts) proporciona una API inyectable y limpia para emitir eventos hacia Socket.io sin acoplar los módulos de negocio a los detalles de implementación del gateway.

```typescript
@Injectable()
export class WebsocketsService {
  private readonly logger = new Logger(WebsocketsService.name);

  constructor(private readonly websocketsGateway: WebsocketsGateway) {}

  /**
   * Emite el evento 'collection:created' a la sala 'collectors:active'
   */
  emitCollectionCreated(payload: any): void {
    this.logger.log(`Emitiendo evento 'collection:created' a la sala 'collectors:active'`);
    this.websocketsGateway.server
      .to('collectors:active')
      .emit('collection:created', payload);
  }

  /**
   * Emite el evento 'batch:completed' a la sala privada del centro de acopio 'center:${centerId}'
   */
  emitBatchCompleted(centerId: string, payload: any): void {
    const room = `center:${centerId}`;
    this.logger.log(`Emitiendo evento 'batch:completed' a la sala '${room}'`);
    this.websocketsGateway.server.to(room).emit('batch:completed', payload);
  }
}
```

---

## 6. Resultados de Compilación y Pruebas

El módulo fue sometido a auditoría de QA y pasó satisfactoriamente las siguientes verificaciones:

1. **Compilación de TypeScript (`npm run build`)**: Exitoso con código de salida `0` y cero advertencias o errores de sintaxis.
2. **Pruebas Unitarias (`npm test`)**: 100% exitosas (2/2 suites pasando, 11/11 pruebas unitarias verificadas).

---

## 7. Guía de Prueba y Ejemplos de Conexión (Client Snippets)

### Ejemplo 1: Cliente Recolector (`RECOLECTOR`)

```typescript
import { io, Socket } from 'socket.io-client';

const collectorToken = 'YOUR_SUPABASE_RECOLECTOR_JWT';

const socket: Socket = io('http://localhost:3000', {
  transports: ['websocket'],
  query: {
    token: collectorToken,
  },
});

socket.on('connect', () => {
  console.log(`[Recolector] Conectado exitosamente con Socket ID: ${socket.id}`);
});

socket.on('collection:created', (data) => {
  console.log('[Recolector] Nueva solicitud de recolección recibida:', data);
});

socket.on('disconnect', (reason) => {
  console.log(`[Recolector] Desconectado: ${reason}`);
});
```

### Ejemplo 2: Cliente Centro de Acopio (`CENTRO_ACOPIO`)

```typescript
import { io, Socket } from 'socket.io-client';

const centerToken = 'YOUR_SUPABASE_CENTRO_ACOPIO_JWT';

const socket: Socket = io('http://localhost:3000', {
  transports: ['websocket'],
  query: {
    token: centerToken,
  },
});

socket.on('connect', () => {
  console.log(`[Centro de Acopio] Conectado exitosamente con Socket ID: ${socket.id}`);
});

socket.on('batch:completed', (data) => {
  console.log('[Centro de Acopio] Lote procesado y finalizado:', data);
});

socket.on('disconnect', (reason) => {
  console.log(`[Centro de Acopio] Desconectado: ${reason}`);
});
```

### Ejemplo 3: Simulación de Rechazo por Token Inválido

```typescript
import { io, Socket } from 'socket.io-client';

const socket: Socket = io('http://localhost:3000', {
  transports: ['websocket'],
  query: {
    token: 'invalid_or_expired_token',
  },
});

socket.on('connect', () => {
  console.log('Conexión inesperada');
});

socket.on('disconnect', (reason) => {
  console.log(`[Seguridad] Cliente desconectado correctamente por el servidor: ${reason}`);
});
```
