# Especificación Técnica y Arquitectura: Módulo Worker de Blockchain (`BlockchainModule`)

**Proyecto:** Livora Backend (NestJS Monorepo)  
**Versión:** 2.0.0 (Stellar Soroban Testnet)  
**Ubicación del Documento:** `docs/specs/06-blockchain-worker-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen Arquitectónico

El **Módulo Worker de Blockchain (`BlockchainModule`)** es el componente asíncrono y de integración Web3 de Livora. Su responsabilidad principal es procesar los trabajos encolados en Redis/BullMQ (`'blockchain-queue'`) tras el pesaje industrial de un lote o una solicitud de canje/liquidación, publicar el manifiesto inmutable en **IPFS (Pinata)**, calcular y distribuir las recompensas en **EcoTokens**, ejecutar transacciones atómicas mediante **`@stellar/stellar-sdk`** hacia el contrato inteligente en **Stellar Soroban**, actualizar el estado persistente en **PostgreSQL (Prisma)** y emitir eventos en tiempo real vía **WebSockets (Socket.IO)**.

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
  [ PASO A: IPFS ]     [ PASO B: TOKENS ]  [ PASO C: XDR/VAL ]   [ PASO D: SOROBAN ]    [ PASO E: PRISMA ]
    IpfsService          Cálculo 80/20 &      nativeToScVal()     BlockchainService      Actualiza Batch
   Pinata REST API      Resolución Wallet     Keypair Ed25519     Circuit Breaker        Estado: RECEIVED
    (CID Hash)          vía Prisma DB                             register_batch()              │
                                                                                                │
                                                                                                ▼
                                                                                       [ PASO F: WEBSOCKET ]
                                                                                         WebsocketsService
                                                                                        emitBatchCompleted()
```

### Principios Clave de Diseño

1. **Desacoplamiento y Procesamiento Asíncrono (HTTP 202 Accepted)**: Separa la API de ingesta industrial del minteo blockchain. El cliente del centro de acopio recibe una respuesta inmediata mientras el worker procesa en segundo plano el anclaje a IPFS y la ejecución en Soroban.
2. **Inmutabilidad y Trazabilidad en IPFS**: El manifiesto completo del lote (IDs de participantes, desglose exacto de materiales y timestamp) es empaquetado y fijado en IPFS antes de invocar la red Stellar.
3. **Resiliencia con Circuit Breaker (Opossum)**: Todas las llamadas RPC a Stellar están envueltas en un Circuit Breaker que detecta fallos transitorios y previene la saturación de conexiones.
4. **Firmado Asíncrono y Relayer Subsidiado**: Uso de `@stellar/stellar-sdk` con una billetera relayer (`WORKER_SECRET_KEY`) fondeada en Testnet para subsidiar los cargos de red a los usuarios finales.

---

## 2. Componentes Implementados

### 2.1 `src/blockchain/services/blockchain.service.ts`
- Inicializa el cliente `StellarRpc.Server`.
- Configura el Circuit Breaker (`Opossum`) con timeouts y umbrales de error (50% fallos en ventana de 10s abre el circuito).
- Gestiona la simulación de transacciones (`simulateTransaction`), ensamblado XDR (`assembleTransaction`) y transmisión de transacciones a la red (`sendTransaction`).
- Funciones de lectura (`balance`, `material_rate`, `is_batch_processed`, `nonces`) y escritura (`registerBatchWeighed`, `transferDelegated`).

### 2.2 `src/blockchain/blockchain.processor.ts` (`WorkerHost`)
- Implementa el consumo de trabajos de BullMQ (`processBatchBlockchain`, `processRedemptionTransfer`, `processSettlementTransfer`).
- Maneja eventos del ciclo de vida del worker (`@OnWorkerEvent('completed')`, `@OnWorkerEvent('failed')`).
- Persiste los hashes de transacción (`txHash`) y CIDs de IPFS (`ipfsCid`) en la tabla `batches`.

### 2.3 `src/blockchain/services/ipfs.service.ts`
- Integra el cliente REST de **Pinata Cloud** (`pinata.pinJSONToIPFS`).
- Genera metadatos estandarizados de manifiesto de reciclaje con fallback defensivo local para entornos de desarrollo/testing.

---

## 3. Variables de Entorno Requeridas

```env
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
WORKER_SECRET_KEY="SAGXFNNNDT6VNRDIEZ3Z5RXYYPX6ZGXSTNCFNVEY6MOZJURQBUR7ERAZ"
ECOTOKEN_CONTRACT_ID="CDTSHH6HOZZ76PNILNWCR63PAM5UDS7FGA3QWZOBP6UYN2WU4PC6GLOJ"
PINATA_API_KEY=tu_pinata_key
PINATA_SECRET_KEY=tu_pinata_secret
WALLET_ENCRYPTION_KEY=tu_32_byte_secret_key
```
