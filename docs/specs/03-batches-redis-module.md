# Especificación Técnica y Arquitectura: Módulo de Lotes y Redis (`BatchesModule`)

**Proyecto:** Livora Backend (NestJS Monorepo)  
**Versión:** 1.0.0  
**Ubicación del Documento:** `docs/specs/03-batches-redis-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen Arquitectónico

El **Módulo de Lotes (`BatchesModule`)** es el componente central en la arquitectura de Livora encargado de supervisar la consolidación, transporte, pesaje industrial y despacho asíncrono de los materiales reciclables. Este módulo gestiona el flujo del material desde el momento en que un recolector finaliza la recolección en los hogares hasta su entrega formal en la planta de un centro de acopio.

```
       [ HOGARES ] 
            │ (Solicitudes ACCEPTED)
            ▼
     [ RECOLECTOR ] ──► GET /batches/open (Enlaza solicitudes -> Lote OPEN)
            │
            │ ──► PATCH /batches/:id (Asigna Centro Destino -> IN_TRANSIT)
            ▼
  [ CENTRO DE ACOPIO ] ──► POST /batches/:id/receive (Pesaje Industrial)
            │
            ├───────────────────────┬────────────────────────┐
            ▼                       ▼                        ▼
    Validación Estado       Idempotencia (HTTP 409)    HTTP 202 Accepted
       (IN_TRANSIT)            (PROCESSING/etc)        + transactionJobId
                                                             │
                                                             ▼
                                                [ BullMQ: blockchain-queue ]
                                                             │
                                                             ▼
                                                  (Arbitrum Stylus Worker)
```

### Principios Clave de Diseño

1. **Trazabilidad On-Chain y Distribución de EcoTokens**: Cada lote consolida un conjunto de solicitudes de recolección (`CollectionRequest`). Este enlace directo preserva el origen exacto de los residuos y permite que, tras la verificación del pesaje industrial, los EcoTokens se distribuyan de forma equitativa y proporcional entre los hogares participantes y el recolector.
2. **Desacoplamiento e Integración Asíncrona (HTTP 202 Accepted)**: El proceso de minado y emisión de transacciones en la blockchain de **Arbitrum Stylus** puede introducir latencia variable. Para garantizar una experiencia de usuario rápida y fluida en la báscula industrial, la API valida el lote, actualiza el estado local a `PROCESSING`, encola el trabajo en Redis vía **BullMQ** y responde de inmediato con HTTP 202 Accepted.
3. **Idempotencia Rigurosa contra Pagos Duplicados**: El pesaje industrial dispara transacciones financieras y de incentivos. El módulo implementa un control de idempotencia estricto que rechaza cualquier reintento sobre lotes en estados `PROCESSING`, `RECEIVED` o `CONSOLIDATED` arrojando un `ConflictException` (HTTP 409 Conflict).

---

## 2. Modelo de Datos (Prisma Schema)

### Enum `BatchStatus`

Define el ciclo de vida por el cual transita un lote de materiales:

```prisma
enum BatchStatus {
  OPEN          // Lote en recolección activa por parte del recolector.
  IN_TRANSIT    // Lote cerrado y en traslado hacia el centro de acopio asignado.
  PROCESSING    // Lote recibido en báscula, pesos registrados y trabajo encolado en BullMQ.
  RECEIVED      // Confirmación de recepción y procesamiento completado.
  CONSOLIDATED  // Lote agrupado para procesamiento industrial masivo / despacho B2B.
}
```

### Modelo `Batch` (Tabla `batches`)

```prisma
model Batch {
  id                  String             @id @default(uuid()) @db.Uuid
  status              BatchStatus        @default(OPEN)
  collectorId         String             @db.Uuid
  destinationCenterId String?            @db.Uuid
  materialsActual     Json?
  consolidatedBatchId String?            @db.Uuid
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt

  collector         User               @relation("CollectorBatches", fields: [collectorId], references: [id])
  destinationCenter User?              @relation("DestinationBatches", fields: [destinationCenterId], references: [id])
  consolidatedBatch ConsolidatedBatch? @relation(fields: [consolidatedBatchId], references: [id])
  requests          CollectionRequest[]

  @@map("batches")
}
```

#### Descripción de Campos y Relaciones
- **`id`**: Clave primaria UUID v4 (`@db.Uuid`).
- **`status`**: Estado actual del lote (`BatchStatus`, valor por defecto: `OPEN`).
- **`collectorId`**: Clave foránea asociada al usuario con rol `RECOLECTOR`.
- **`destinationCenterId`**: Clave foránea opcional asociada al usuario con rol `CENTRO_ACOPIO`.
- **`materialsActual`**: Objeto JSON que almacena el desglose de los pesos finales registrados en la báscula industrial del centro de acopio (ej: `{"PET": 15.5, "HDPE": 8.2}`).
- **`requests`**: Relación uno a muchos con `CollectionRequest`. Representa las solicitudes de recolección contenidas en este lote.

---

## 3. Configuración de Redis y BullMQ

La arquitectura asíncrona utiliza **Redis 7** y **BullMQ** configurados globalmente en la aplicación.

### 1. Infraestructura Docker (`docker-compose.yml`)
```yaml
services:
  redis:
    image: redis:7-alpine
    container_name: livora_redis
    restart: always
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data
```

### 2. Configuración Global (`AppModule`)
Se registra `BullModule.forRootAsync` de manera global utilizando `ConfigService` para leer las variables de entorno `REDIS_HOST` y `REDIS_PORT`:

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    connection: {
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
    },
  }),
})
```

### 3. Registro de Cola (`BatchesModule`)
En `BatchesModule` se declara la cola `'blockchain-queue'`, encargada de recibir las tareas de sincronización on-chain:

```typescript
BullModule.registerQueue({
  name: 'blockchain-queue',
})
```

---

## 4. Catálogo de Endpoints Implementados

### 1. `GET /batches/open`
- **Rol Requerido**: `RECOLECTOR`
- **Descripción**: Busca el lote actual en estado `OPEN` perteneciente al recolector autenticado. Si no existe ninguno, crea uno nuevo. Adicionalmente, busca todas las solicitudes de recolección en estado `ACCEPTED` del recolector que no tengan un `batchId` asignado y las vincula automáticamente a este lote.
- **Respuesta (200 OK)**: Retorna la entidad del lote junto con el arreglo de solicitudes asociadas e información básica de los hogares.

---

### 2. `PATCH /batches/:id`
- **Rol Requerido**: `RECOLECTOR`
- **Parámetros**: `id` (UUID del lote)
- **Cuerpo (`UpdateBatchDto`)**:
  ```json
  {
    "destinationCenterId": "3b2411cf-7128-4e8c-9c09-467406a4b111"
  }
  ```
- **Reglas de Negocio**:
  1. Verifica que el lote exista y pertenezca al recolector autenticado (`403 Forbidden`).
  2. Valida que el estado actual del lote sea `OPEN` (`400 Bad Request`).
  3. Verifica que el usuario destino exista y posea el rol `CENTRO_ACOPIO` (`400 Bad Request`).
  4. Actualiza `destinationCenterId` y asigna el estado `IN_TRANSIT`.
- **Respuesta (200 OK)**: Entidad del lote actualizada en estado `IN_TRANSIT`.

---

### 3. `POST /batches/:id/receive` (Endpoint Crítico)
- **Rol Requerido**: `CENTRO_ACOPIO`
- **Código de Respuesta**: `HTTP 202 Accepted`
- **Parámetros**: `id` (UUID del lote)
- **Cuerpo (`ReceiveBatchDto`)**:
  ```json
  {
    "materialsActual": {
      "PET": 15.5,
      "HDPE": 8.2,
      "Carton": 12.0
    }
  }
  ```
- **Flujo de Ejecución y Validaciones**:
  1. **Verificación de Existencia**: Retorna `404 Not Found` si el lote no existe.
  2. **Control de Idempotencia (HTTP 409 Conflict)**: Si el lote se encuentra en estado `PROCESSING`, `RECEIVED` o `CONSOLIDATED`, rechaza inmediatamente con `ConflictException` para evitar emisiones duplicadas de tokens.
  3. **Verificación de Estado (HTTP 400 Bad Request)**: Exige que el lote esté en estado `IN_TRANSIT`.
  4. **Verificación de Destino (HTTP 403 Forbidden)**: Valida que el `centerId` autenticado coincida exactamente con el `destinationCenterId` del lote.
  5. **Actualización e Integración Asíncrona**:
     - Actualiza el lote en base de datos a estado `PROCESSING` y guarda `materialsActual`.
     - Extrae la lista de `householdIds` participantes de las solicitudes asociadas.
     - Encola un trabajo en `'blockchain-queue'` con el payload completo (Opción 3A):
       ```typescript
       {
         batchId: "...",
         collectorId: "...",
         centerId: "...",
         materialsActual: { ... },
         householdIds: ["uuid-1", "uuid-2"]
       }
       ```
- **Respuesta (202 Accepted)**:
  ```json
  {
    "status": "PROCESSING",
    "batchId": "a1b2c3d4-e5f6-7890-abcd-1234567890ab",
    "transactionJobId": "104"
  }
  ```

---

## 5. Seguridad y Control de Acceso

La seguridad del módulo se soporta en la infraestructura común de la aplicación:

- **`SupabaseAuthGuard`**: Valida el Token JWT emitido por Supabase en el encabezado `Authorization: Bearer <token>` e inyecta la entidad del usuario autenticado en `request.user`.
- **`RolesGuard`**: Evalúa los roles asignados mediante la anotación `@Roles(...)`.
- **Decoradores Decorativos y de Parámetros**:
  - `@Roles(Role.RECOLECTOR)`
  - `@Roles(Role.CENTRO_ACOPIO)`
  - `@CurrentUser('id')`: Extrae limpiamente el identificador del usuario autenticado.
  - `@HttpCode(HttpStatus.ACCEPTED)`: Asegura el retorno explícito del código HTTP 202 en la recepción industrial.
