# Especificación Técnica y Arquitectura: Módulo de Smart Contracts y Stylus (`EcoBatchRegistry`)

**Proyecto:** Livora Web3 Core (Arbitrum Stylus / Rust)  
**Versión:** 1.0.0  
**Ubicación del Documento:** `docs/specs/05-smart-contract-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen y Propósito del Módulo

El módulo de Smart Contracts de **Livora** constituye el núcleo de confianza descentralizado y liquidación de incentivos de la plataforma. Implementado en la tecnología de última generación **Arbitrum Stylus** utilizando **Rust**, el contrato inteligente `EcoBatchRegistry` fusiona dos responsabilidades esenciales dentro de una misma arquitectura de alto rendimiento:

1. **EcoToken (ERC-20 Fungible Token)**: Representa el token de recompensa `ECO` acuñado on-chain bajo demandad para incentivar a los hogares clasificadores y a los recolectores por su aporte ecológico.
2. **BatchRegistry (Trazabilidad Inmutable de Lotes)**: Registra de forma definitiva e inalterable cada lote consolidado y pesado en los centros de acopio, enlazando la transacción on-chain con el detalle granular off-chain hospedado en la red IPFS (Pinata).

```
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                            NESTJS BACKEND WORKER                            │
   │           (Genera Metadata IPFS -> Pinata & Envía Transacción EVM)          │
   └──────────────────────────────────────┬──────────────────────────────────────┘
                                          │
                                          ▼
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                  ARBITRUM STYLUS (WASM Execution Engine)                    │
   │                     Contrato: EcoBatchRegistry (Rust)                       │
   │                                                                             │
   │   ┌─────────────────────────────────┐   ┌───────────────────────────────┐   │
   │   │     BatchRegistry Module        │   │     EcoToken (ERC-20) Core    │   │
   │   │  • Validar Idempotencia         │   │  • Minting a Hogares (Recip)  │   │
   │   │  • Guardar CID de IPFS          │───┼─►• Minting a Recolector      │   │
   │   │  • Registro de Timestamp        │   │  • Emisión Evento Transfer    │   │
   │   └─────────────────────────────────┘   └───────────────────────────────┘   │
   └─────────────────────────────────────────────────────────────────────────────┘
```

### Ventajas de Arbitrum Stylus frente a Solidity Tradicional
- **Eficiencia de Ejecución WASM**: Stylus compila código Rust a WebAssembly (WASM), permitiendo ejecutar lógica compleja con consumos de gas sustancialmente menores a la EVM tradicional.
- **Seguridad de Tipos en Rust**: Cero excepciones por desbordamiento numérico no controlado (*arithmetic overflow*) y gestión rigurosa de memoria a nivel de compilador.
- **Interoperabilidad EVM Completa**: El contrato es 100% compatible con Solidity y la EVM estándar; expone una interfaz ABI accesible por clientes Web3 estándar (`ethers.js`, `viem`, `ethers-rs`).

---

## 2. Arquitectura de Costos y Off-Chain (IPFS / Pinata)

Para prevenir el problema de **State Bloat** (encarecimiento del almacenamiento en la cadena de bloques por guardar estructuras pesadas), Livora implementa una arquitectura híbrida **On-Chain / Off-Chain**.

```
  ┌─────────────────────────────────────────┐
  │         Detalle Completo del Lote       │
  │  • IDs de Recolecciones Individuales    │
  │  • Desglose por Material (PET, Cartón)  │
  │  • Pesos en Báscula (kg) & Fotos        │
  │  • Firma Digital del Centro de Acopio   │
  └────────────────────┬────────────────────┘
                       │
                       ▼
            [ Pinata IPFS Service ]
                       │
                       ▼
            CID: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"
                       │
                       ▼ (Solo el hash CID de 46 chars se almacena On-Chain)
  ┌─────────────────────────────────────────┐
  │     Arbitrum Stylus: EcoBatchRegistry   │
  │  • batch_id (bytes32)                   │
  │  • ipfs_cid (string)                    │
  │  • timestamp (uint64)                   │
  └─────────────────────────────────────────┘
```

### Razones Técnicas del Diseño Off-Chain

1. **Optimización Extrema del Gas**: Almacenar cadenas largas de texto, objetos JSON o desgloses por usuario directamente en la memoria de estado de Ethereum/Arbitrum incrementa el costo de la transacción exponencialmente. Al subir el manifiesto JSON a **IPFS vía Pinata**, el contrato solo necesita almacenar el hash criptográfico `ipfs_cid` de 46 caracteres.
2. **Verificabilidad Criptográfica**: El CID (Content Identifier) en IPFS es un hash basado en el contenido. Cualquier alteración de un solo byte en la metadata del lote cambiaría el CID, garantizando que los datos guardados en Pinata sean 100% inmutables y auditables por terceros.

---

## 3. Especificación del Contrato Inteligente (Rust/Alloy)

El contrato se estructura utilizando las macros oficiales de **Stylus SDK** (`sol_storage!`, `sol!`, `#[entrypoint]`, `#[public]`).

### 3.1 Estructuras de Almacenamiento (`sol_storage!`)

```rust
sol_storage! {
    #[entrypoint]
    pub struct EcoBatchRegistry {
        // Control de Acceso y Roles
        address owner;
        address worker_address;

        // ERC-20 State
        uint256 total_supply;
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;

        // BatchTraceability State
        mapping(bytes32 => bool) processed_batches;
        mapping(bytes32 => uint64) batch_timestamps;
        mapping(bytes32 => uint256) batch_total_rewards;
        mapping(bytes32 => uint32) batch_recipients_counts;
    }
}
```

### 3.2 Interfaz Solidity y Eventos (`sol!`)

```rust
sol! {
    // --- Eventos On-Chain ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event BatchRegistered(
        bytes32 indexed batch_id,
        string ipfs_cid,
        address indexed worker,
        uint256 total_reward,
        uint32 recipients_count,
        uint64 timestamp
    );
    event WorkerUpdated(address indexed old_worker, address indexed new_worker);

    // --- Errores Personalizados ---
    error Unauthorized(address caller);
    error BatchAlreadyExists(bytes32 batch_id);
    error InvalidBatchId();
    error InvalidInputLength();
    error InvalidRecipient();
    error ZeroAmount();
    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 needed);
}
```

### 3.3 Control de Acceso por Roles (`owner` y `worker_address`)

- **`owner`**: Dirección administradora del contrato asignada en el despliegue (`init`). Posee facultades para actualizar la dirección del worker.
- **`worker_address`**: Dirección autorizada del servicio backend de NestJS. Únicamente esta dirección (o el owner) tiene permisos para registrar lotes y mintear tokens.

```rust
fn require_worker_or_owner(&self) -> Result<(), Vec<u8>> {
    let sender = msg::sender();
    let worker = self.worker_address.get();
    let owner = self.owner.get();
    if sender != worker && sender != owner {
        return Err(Unauthorized { caller: sender }.abi_encode());
    }
    Ok(())
}
```

### 3.4 Distribución Masiva y Vectorizada (`register_batch`)

Para optimizar el uso de bloques y evitar enviar N transacciones individuales por cada hogar participante en un lote, la función `register_batch` acepta **vectores paralelos** de direcciones y montos:

```rust
#[public]
impl EcoBatchRegistry {
    pub fn register_batch(
        &mut self,
        batch_id: B256,
        ipfs_cid: String,
        recipients: Vec<Address>,
        amounts: Vec<U256>,
    ) -> Result<bool, Vec<u8>> {
        // 1. Control de Acceso
        self.require_worker_or_owner()?;

        // 2. Validación de Idempotencia
        if self.processed_batches.get(batch_id) {
            return Err(BatchAlreadyExists { batch_id }.abi_encode());
        }
        if batch_id == B256::ZERO {
            return Err(InvalidBatchId {}.abi_encode());
        }

        // 3. Validación de Entrada
        if recipients.len() != amounts.len() || recipients.is_empty() {
            return Err(InvalidInputLength {}.abi_encode());
        }

        // 4. Minteo Atómico Vectorizado
        let mut total_batch_reward = U256::ZERO;
        let now = block::timestamp();

        for i in 0..recipients.len() {
            let recipient = recipients[i];
            let amount = amounts[i];

            if recipient == Address::ZERO {
                return Err(InvalidRecipient {}.abi_encode());
            }
            if amount == U256::ZERO {
                return Err(ZeroAmount {}.abi_encode());
            }

            self.internal_mint(recipient, amount);
            total_batch_reward += amount;
        }

        // 5. Registro de Estado de Trazabilidad
        self.processed_batches.insert(batch_id, true);
        self.batch_timestamps.insert(batch_id, U64::from(now));
        self.batch_total_rewards.insert(batch_id, total_batch_reward);
        self.batch_recipients_counts.insert(batch_id, U32::from(recipients.len()));

        // 6. Emisión del Evento On-Chain
        evm::log(BatchRegistered {
            batch_id,
            ipfs_cid,
            worker: msg::sender(),
            total_reward: total_batch_reward,
            recipients_count: recipients.len() as u32,
            timestamp: now,
        });

        Ok(true)
    }
}
```

---

## 4. Mecanismo de Idempotencia y Seguridad

El pesaje de lotes activa la emisión de activos financieros (EcoTokens). El sistema previene estrictamente ataques de reentrega (*replay attacks*) o pagos duplicados mediante una verificación en 3 capas:

```
[ Solicitud HTTP: Backend Worker ]
               │
               ▼
┌──────────────────────────────┐
│  1. NestJS Redis Lock        │ ──► Rechaza transacciones simultáneas del mismo Lote
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  2. BullMQ Job Idempotency   │ ──► Job ID = `batch-${batchId}`
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  3. Stylus Smart Contract    │ ──► Reverts immediately with `BatchAlreadyExists(batch_id)`
│     (processed_batches)      │     if mapping returns true on-chain
└──────────────────────────────┘
```

### Reglas de Seguridad Inalterables
1. **Verificación On-Chain Inmediata**: Si `processed_batches.get(batch_id)` es `true`, la transacción revierte de inmediato sin consumir gas excesivo.
2. **Validación Cero-Dirección y Cero-Monto**: Si cualquier elemento en el vector contiene `Address::ZERO` o un monto de 0 tokens, toda la ejecución revierte atómicamente (*Atomic Rollback*).
3. **Imposibilidad de Modificar Lotes**: Una vez registrado un `batch_id`, su `ipfs_cid` y `timestamp` quedan sellados permanentemente en la blockchain.

---

## 5. Guía de Despliegue y Pruebas (Arbitrum Sepolia)

### 5.1 Prerrequisitos de Desarrollo
- **Rust Toolchain**: `rustup` v1.90.0 instalado.
- **Target WebAssembly**: `wasm32-unknown-unknown`.
- **Cargo Stylus CLI**: Tool oficial de Arbitrum Stylus (`cargo stylus` v0.6.3+).

```bash
# Instalación del target WASM y la CLI de Stylus
rustup target add wasm32-unknown-unknown
cargo install cargo-stylus
```

### 5.2 Comandos de Compilación y Verificación Local

Ubicación del proyecto: `contracts/ecotoken_registry/`

```bash
# 1. Compilación de prueba a target WASM
cargo check --target wasm32-unknown-unknown --manifest-path contracts/ecotoken_registry/Cargo.toml

# 2. Verificación de reglas de Stylus (Validación de opcodes EVM y compatibilidad WASM)
cd contracts/ecotoken_registry
cargo stylus check
```

### 5.3 Exportación de ABI Solidity

Para actualizar las interfaces de TypeScript / Ethers.js en el backend de NestJS:

```bash
cargo run --bin ecotoken_registry_abi --features export-abi --manifest-path contracts/ecotoken_registry/Cargo.toml
```

### 5.4 Despliegue en Red de Pruebas (Arbitrum Sepolia)

1. **Obtención de Gas de Prueba (ETH)**:
   - Solicitar ETH de prueba para la red **Arbitrum Sepolia** desde el faucet oficial de Arbitrum: [faucet.quicknode.com/arbitrum/sepolia](https://faucet.quicknode.com/arbitrum/sepolia).
2. **Ejecución del Comando de Despliegue**:

```bash
cd contracts/ecotoken_registry

# Despliegue con la llave privada del wallet deployer
cargo stylus deploy \
  --endpoint="https://sepolia-rollup.arbitrum.io/rpc" \
  --private-key="0xTU_LLAVE_PRIVADA_AQUI"
```

3. **Configuración de Variables de Entorno en NestJS Backend**:
   - Una vez desplegado el contrato, copiar la dirección del contrato generado y actualizar las variables de entorno `.env` en la raíz del backend:

```env
ECOTOKEN_CONTRACT_ADDRESS=0xDireccionDelContratoDesplegadoEnArbitrumSepolia
ARBITRUM_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
WORKER_PRIVATE_KEY=0xLlavePrivadaDelBackendWorker
```
