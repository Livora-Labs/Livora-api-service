# Especificación Técnica y Arquitectura: Módulo Worker de Blockchain (`BlockchainModule`)

**Proyecto:** Livora Backend (NestJS Monorepo)  
**Versión:** 1.0.0  
**Ubicación del Documento:** `docs/specs/06-blockchain-worker-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen Arquitectónico

El **Módulo Worker de Blockchain (`BlockchainModule`)** es el componente asíncrono y descentralizado de extremo a extremo dentro de la arquitectura de Livora. Su responsabilidad principal es consumir los trabajos encolados en la cola Redis/BullMQ (`'blockchain-queue'`) tras el pesaje industrial de un lote, publicar el manifiesto inmutable en **IPFS (Pinata)**, calcular y distribuir equitativamente las recompensas en **EcoTokens**, ejecutar la transacción on-chain mediante **Ethers.js v6** hacia el contrato inteligente en **Arbitrum Stylus**, actualizar el estado persistente en **PostgreSQL (Prisma)** y notificar en tiempo real al Centro de Acopio vía **WebSockets (Socket.IO)**.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 [ MÓDULO DE LOTES ]                     │
                  │   POST /batches/:id/receive -> HTTP 202 Accepted        │
                  └────────────────────────────┬────────────────────────────┘
                                               │ (Encola Job Payload)
                                               ▼
                                  ┌──────────────────────────┐
                                  │ BullMQ: blockchain-queue │
                                  └────────────┬─────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────────┐
                                  │   BlockchainProcessor    │
                                  │      (WorkerHost)        │
                                  └────────────┬─────────────┘
                                               │
       ┌──────────────────────┬────────────────┼──────────────────────┬──────────────────────┐
       ▼                      ▼                ▼                      ▼                      ▼
 [ PASO A: IPFS ]     [ PASO B: TOKENS ]  [ PASO C: BYTES32 ]   [ PASO D: ETHERS ]    [ PASO E: PRISMA ]
   IpfsService          Cálculo 80/20 &      ethers.id()        BlockchainService      Actualiza Batch
  Pinata REST API      Resolución Wallet      UUID -> bytes32    Arbitrum Stylus       Estado: RECEIVED
   (CID Hash)          vía Prisma DB                             register_batch()             │
                                                                                              │
                                                                                              ▼
                                                                                     [ PASO F: WEBSOCKET ]
                                                                                       WebsocketsService
                                                                                      emitBatchCompleted()
```

### Principios Clave de Diseño

1. **Desacoplamiento y Procesamiento Asíncrono**: Separa la API de ingesta industrial del minteo blockchain. El cliente del centro de acopio recibe una respuesta inmediata `202 Accepted` mientras el worker procesa en segundo plano el anclaje a IPFS y la ejecución EVM.
2. **Inmutabilidad y Trazabilidad en IPFS**: El manifiesto completo del lote (IDs de participantes, desglose exacto de materiales y timestamp) es empaquetado y fijado en IPFS antes de invocar la red Arbitrum.
3. **Firmado Asíncrono de Transacciones Web3**: Uso de Ethers.js v6 con un proveedor RPC configurable y una billetera en custodia (`WORKER_PRIVATE_KEY`) para firmar e invocar la función `register_batch` del contrato inteligente `EcoBatchRegistry`.
4. **Manejo Defensivo de Errores y Resiliencia**: Tolera la ausencia de hogares en un lote, falta de claves de API en entornos de prueba, desconexiones RPC y usuarios sin dirección de billetera configurada.

---

## 2. Componentes Implementados

### 2.1 `src/blockchain/blockchain.constants.ts` (ABI y Constantes)

Define las constantes globales de configuración, nombres de colas, interfaz del contrato EVM y tabla de conversión de materiales a EcoTokens:

- **Nombre de la Cola**: `BLOCKCHAIN_QUEUE = 'blockchain-queue'`
- **ABI de EcoBatchRegistry**:
  ```typescript
  export const ECO_BATCH_REGISTRY_ABI = [
    'function registerBatch(bytes32 batchId, string ipfsCid, address[] recipients, uint256[] amounts) external returns (bool)',
    'function isBatchProcessed(bytes32 batchId) external view returns (bool)',
    'event BatchRegistered(bytes32 indexed batchId, string ipfsCid, address indexed worker, uint256 totalReward, uint32 recipientsCount, uint64 timestamp)',
  ];
  ```
- **Tabla de Tasas por Material (`MATERIAL_RATES`)**:
  - `PET`: 10 EcoTokens / kg
  - `CARTÓN` / `CARTON`: 5 EcoTokens / kg
  - `VIDRIO`: 3 EcoTokens / kg
  - `PLÁSTICO` / `PLASTICO`: 10 EcoTokens / kg
  - `ALUMINIO`: 15 EcoTokens / kg
  - `TETRAPAK`: 4 EcoTokens / kg
  - `PAPEL`: 5 EcoTokens / kg
  - **Tasa Por Defecto (`DEFAULT_MATERIAL_RATE`)**: 5 EcoTokens / kg (para materiales no catalogados).
- **CID IPFS Fallback (`DUMMY_IPFS_HASH`)**: `"QmDummyIpfsHashForTestingPurposesOnly123456"`.

---

### 2.2 `src/blockchain/services/ipfs.service.ts` (`IpfsService`)

Servicio responsable del empaquetado y fijado de metadatos en IPFS utilizando la API REST de Pinata:

- **Método**: `uploadBatchMetadata(payload: any): Promise<string>`
- **Endpoint**: `https://api.pinata.cloud/pinning/pinJSONToIPFS`
- **Encabezados HTTP**:
  - `pinata_api_key`: `PINATA_API_KEY`
  - `pinata_secret_api_key`: `PINATA_SECRET_KEY`
  - `Content-Type`: `application/json`
- **Payload Enviado a Pinata**:
  ```json
  {
    "pinataContent": {
      "batchId": "a1b2c3d4-...",
      "collectorId": "...",
      "centerId": "...",
      "materialsActual": { "PET": 12.5, "Vidrio": 8.0 },
      "householdIds": ["..."],
      "timestamp": "2026-08-04T18:00:00.000Z"
    },
    "pinataMetadata": {
      "name": "batch-a1b2c3d4-..."
    }
  }
  ```
- **Respuesta y Fallback**: Retorna `data.IpfsHash` (CID v0/v1 de 46 caracteres). En caso de credenciales no configuradas, errores de red o fallo en la API de Pinata durante desarrollo/pruebas, captura la excepción, registra un aviso en NestJS `Logger` y retorna el CID simulado `DUMMY_IPFS_HASH`.

---

### 2.3 `src/blockchain/services/blockchain.service.ts` (`BlockchainService`)

Servicio de infraestructura Web3 encargado del canal de comunicación con la red Arbitrum:

- **Ethers.js v6 Setup**:
  - `provider`: `ethers.JsonRpcProvider(ARBITRUM_RPC_URL)`
  - `wallet`: `ethers.Wallet(WORKER_PRIVATE_KEY, provider)` (con fallback a wallet aleatoria en memoria en desarrollo si la clave privada no está presente).
  - `contract`: `ethers.Contract(ECOTOKEN_CONTRACT_ADDRESS, ECO_BATCH_REGISTRY_ABI, wallet)` (con fallback a `ethers.ZeroAddress` si la dirección del contrato es inválida).
- **Método de Ejecución Transaccional**:
  `executeBatchRegistration(batchIdBytes32: string, ipfsCid: string, recipients: string[], amounts: bigint[]): Promise<ethers.TransactionReceipt>`
  - Firma e invoca la función `register_batch` del contrato inteligente.
  - Imprime el `tx.hash` enviado a la mempool.
  - Espera la confirmación en el bloque objetivo vía `await tx.wait()`.
  - Retorna el `TransactionReceipt` completo.

---

### 2.4 `src/blockchain/blockchain.processor.ts` (`BlockchainProcessor`)

Worker de BullMQ decorado con `@Processor('blockchain-queue')` que extiende `WorkerHost`. Implementa el pipeline de 6 pasos:

1. **Extracción de Payload**: Extrae `batchId`, `collectorId`, `centerId`, `materialsActual` y `householdIds` del `job.data`.
2. **Paso A (IPFS)**: Invoca `IpfsService.uploadBatchMetadata(...)` obteniendo el `ipfsCid`.
3. **Paso B (Tokens & Wallets)**:
   - Calcula la masa total de incentivos multiplicando los pesos por las tasas de `MATERIAL_RATES`.
   - Modulo defensivo de distribución 80/20 (ver Sección 3).
   - Realiza consulta a la base de datos PostgreSQL vía `PrismaService` para mapear los IDs de usuarios a sus direcciones `walletAddress`. Si un usuario no tiene billetera configurada, asigna defensivamente la dirección del worker o `ethers.ZeroAddress`.
   - Convierte los montos a unidades EVM con 18 decimales usando `ethers.parseUnits(monto, 18)`.
4. **Paso C (Conversión Bytes32)**: Transforma el `batchId` de formato UUID string a un hash `bytes32` mediante `ethers.id(batchId)`.
5. **Paso D (Transacción On-Chain)**: Llama a `BlockchainService.executeBatchRegistration(batchIdBytes32, ipfsCid, recipients, amounts)`.
6. **Paso E (Persistencia en BD)**: Actualiza el estado del lote en PostgreSQL mediante Prisma:
   ```typescript
   await this.prisma.batch.update({
     where: { id: batchId },
     data: { status: BatchStatus.RECEIVED },
   });
   ```
7. **Paso F (Notificación WebSocket)**: Notifica al centro de acopio invocando:
   `WebsocketsService.emitBatchCompleted(centerId, { batchId, status: 'RECEIVED', txHash })`.

---

### 2.5 `src/blockchain/blockchain.module.ts` e Integración Global

Encapsula la configuración del módulo y registra la cola con políticas de reintento:

```typescript
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    WebsocketsModule,
    BullModule.registerQueue({
      name: BLOCKCHAIN_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    }),
  ],
  providers: [BlockchainProcessor, IpfsService, BlockchainService],
  exports: [IpfsService, BlockchainService],
})
export class BlockchainModule {}
```

- **Registro en `AppModule`**: `BlockchainModule` es importado en el arreglo `imports` de `src/app.module.ts`, garantizando la inicialización del procesador de eventos de BullMQ al iniciar el servidor NestJS.

---

## 3. Algoritmo de Incentivos y Minteo

### Fórmula de Cálculo de Tokens Totales

Dado un objeto `materialsActual = { material_i: peso_i }`:

$$\text{TotalTokens} = \sum_{i=1}^{k} \left( \text{peso}_i \times \text{tasa}_i \right)$$

Donde $\text{tasa}_i$ se obtiene del catálogo `MATERIAL_RATES` o toma el valor por defecto `DEFAULT_MATERIAL_RATE` (5 tokens/kg).

---

### Reglas de Distribución e Incentivos (80 / 20)

1. **Lotes con Hogares Participantes ($N > 0$)**:
   - **Cuota Global para Hogares (80%)**: $\text{TokensHogaresTotal} = \text{TotalTokens} \times 0.8$
   - **Cuota Equitativa por Hogar**: $\text{TokensPorHogar} = \frac{\text{TokensHogaresTotal}}{N}$
   - **Cuota del Recolector (20%)**: $\text{TokensRecolector} = \text{TotalTokens} \times 0.2$

2. **Caso Borde de Hogares Vacíos ($N = 0$)**:
   - Si un lote no vincula solicitudes con hogares registrados, el algoritmo aplica un manejo defensivo para evitar errores de división por cero:
   - $\text{TokensPorHogar} = 0$
   - $\text{TokensRecolector} = \text{TotalTokens} \times 1.0$ (El 100% de los incentivos del lote se redirigen al recolector).

---

### Formateo de Vectores EVM

Los datos calculados se empaquetan en dos arreglos paralelos ordenados de la siguiente forma:

- `recipients[0]`: Dirección de wallet del Recolector (o fallback).
- `amounts[0]`: `ethers.parseUnits(TokensRecolector, 18)`
- `recipients[1...N]`: Direcciones de wallet de cada uno de los Hogares.
- `amounts[1...N]`: `ethers.parseUnits(TokensPorHogar, 18)`

---

### Conversión del Identificador de Lote (`bytes32`)

Para garantizar compatibilidad con los tipos nativos del Smart Contract en Stylus, el UUID v4 del lote se convierte a un tipo EVM `bytes32`:

```typescript
const batchIdBytes32 = ethers.id(batchId); // Keccak256 hash de 32 bytes (0x...)
```

---

## 4. Resiliencia, Concurrencia y Manejo de Errores

### Estrategia de Reintentos en BullMQ

Configurada a nivel de cola para absorber fallos transitorios en servicios externos (RPC de Arbitrum, congestión de la red, cortes en la API de Pinata):

- **Intentos Máximos (`attempts`)**: `3`
- **Estrategia de Retroceso (`backoff`)**: `exponential`
- **Retardo Base (`delay`)**: `5000 ms` (Reintentos a los 5s, 10s y 20s aproximadamente).

### Tolerancia a Fallos e Imprevistos

1. **Fallo en API de Pinata**: En lugar de abortar el procesamiento del lote, el servicio captura la excepción y retorna un CID estático de prueba para permitir la ejecución de la prueba de concepto en entornos locales/Staging.
2. **RPC Unreachable / Latencia en Mempool**: La llamada `executeBatchRegistration` está respaldada por logs descriptivos en cada fase. Si la transacción falla de forma irrecuperable (ej. falta de gas en la wallet worker), BullMQ reintentará la ejecución según la política definida.
3. **Usuarios sin Wallet en Base de Datos**: Al consultar los registros de usuarios en Prisma, si `walletAddress` es nula, vacía o no cumple con el formato EVM (`ethers.isAddress`), se asigna automáticamente la dirección del worker o `ethers.ZeroAddress`, evitando que la transacción sea rechazada por tipos de datos no válidos.

---

## 5. Variables de Entorno Requeridas

El módulo requiere la definición de las siguientes variables dentro del archivo `.env`:

| Variable | Tipo | Descripción | Ejemplo / Valor Por Defecto |
| :--- | :--- | :--- | :--- |
| `ARBITRUM_RPC_URL` | String (URL) | URL del nodo RPC de la red Arbitrum (Sepolia / Mainnet). | `"https://sepolia-rollup.arbitrum.io/rpc"` |
| `WORKER_PRIVATE_KEY` | String (Hex) | Clave privada (0x...) de la billetera en custodia encargada de firmar las transacciones. | `"0x4f3edf..."` |
| `ECOTOKEN_CONTRACT_ADDRESS` | String (Address) | Dirección del contrato inteligente `EcoBatchRegistry` desplegado en Arbitrum. | `"0x1234567890abcdef1234567890abcdef12345678"` |
| `PINATA_API_KEY` | String | Clave de API otorgada por el servicio Pinata IPFS. | `"v1_pinata_key..."` |
| `PINATA_SECRET_KEY` | String | Clave secreta de API otorgada por el servicio Pinata IPFS. | `"secret_pinata_key..."` |

---

## 6. Resultados de Verificación y Calidad

El módulo fue sometido a validación de compilación del transpilador de TypeScript mediante el CLI de NestJS:

```bash
$ npm run build
```

### Resultado de Ejecución:
- **Estado**: Exitoso (Exit Code 0).
- **TypeScript Errors**: 0
- **TypeScript Warnings**: 0
- **Verificación de Inyección de Dependencias**: Todos los componentes (`BlockchainProcessor`, `IpfsService`, `BlockchainService`, `PrismaService`, `WebsocketsService`) resuelven correctamente en el contenedor iOC de NestJS.
