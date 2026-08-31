# Especificación Técnica y Arquitectura: Módulo de Smart Contracts en Stellar Soroban (`EcoBatchRegistry`)

**Proyecto:** Livora Web3 Core (Stellar Soroban / Rust WASM)  
**Versión:** 2.0.0 (Stellar Testnet / Soroban SDK v21)  
**Ubicación del Documento:** `docs/specs/05-smart-contract-module.md`  
**Estado:** Aprobado & En Producción  

---

## 1. Resumen y Propósito del Módulo

El contrato inteligente **`EcoBatchRegistry`** constituye el núcleo de liquidación de incentivos y registro inmutable de trazabilidad de la plataforma **Livora**. Desarrollado en **Rust** utilizando el **Soroban SDK (v21)** de **Stellar** y compilado a **WebAssembly (`wasm32-unknown-unknown`)**, el contrato integra dos responsabilidades fundamentales:

1. **EcoToken (SEP-41 Fungible Token Standard)**: Token de recompensa `ECO` con 7 decimales (Stroops), funciones estándar de transferencia (`transfer`, `transfer_from`, `approve`, `balance`), y emisión controlada (`mint`).
2. **BatchRegistry & Trazabilidad Inmutable**: Registro atómico de lotes industriales verificados en báscula (`register_batch_weighed` / `register_batch`), cálculo transparente on-chain de tarifas por material, distribución automática 80% hogares / 20% recolector, y soporte de **transferencias delegadas sin gas con firmas criptográficas Ed25519 (`transfer_delegated`)**.

```
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                            NESTJS BACKEND WORKER                            │
   │           (Genera Manifiesto IPFS -> Pinata & Envía Transacción Soroban)    │
   └──────────────────────────────────────┬──────────────────────────────────────┘
                                          │
                                          ▼
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │                      STELLAR SOROBAN (WASM Engine)                          │
   │                     Contrato: EcoBatchRegistry (Rust)                       │
   │                                                                             │
   │   ┌─────────────────────────────────┐   ┌───────────────────────────────┐   │
   │   │     BatchRegistry Module        │   │     EcoToken (SEP-41) Core    │   │
   │   │  • Validar Idempotencia Lote    │   │  • Minteo Atómico 80% Hogar   │   │
   │   │  • Tarifas por Material         │───┼─►• Minteo Atómico 20% Recolec │   │
   │   │  • Enlace a Manifiesto IPFS CID │   │  • Firma Delegada (Ed25519)   │   │
   │   │  • Extensión Automática de TTL  │   │  • Control de Nonces          │   │
   │   └─────────────────────────────────┘   └───────────────────────────────┘   │
   └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Arquitectura de Almacenamiento y Estado en Soroban

Soroban gestiona el almacenamiento en dos capas: **Instance Storage** (datos globales del contrato) y **Persistent Storage** (balances individuales, nonces y lotes), aplicando políticas de expiración y **extensión de Time-To-Live (TTL)**.

### Constantes de Gestión de TTL (Ledgers)
- `DAY_IN_LEDGERS = 17,280` (~5 segundos por bloque).
- `PERSISTENT_TTL_THRESHOLD = 6 * DAY_IN_LEDGERS` (~6 días).
- `PERSISTENT_TTL_EXTEND = 30 * DAY_IN_LEDGERS` (~30 días).

### Estructura de Claves de Datos (`DataKey`)

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,                          // Instance: Dirección del Owner
    Worker,                         // Instance: Dirección del Relayer / Worker
    TotalSupply,                    // Instance: Suministro total circulante de ECO
    Balance(Address),               // Persistent: Saldo por usuario
    Allowance(Address, Address),    // Persistent: Permiso de gasto SEP-41
    Nonce(Address),                 // Persistent: Contador anti-replay para firmas
    ProcessedBatch(BytesN<32>),     // Persistent: Bandera booleana de idempotencia
    BatchDetails(BytesN<32>),       // Persistent: Metadatos estructurados del lote
    MaterialRate(Symbol),           // Persistent: Tarifa en Stroops/kg por material
    DefaultRate,                    // Instance: Tarifa fallback (5 ECO/kg)
    CollectorShareBps,              // Instance: Porcentaje del recolector en BPS (2,000 = 20%)
}
```

---

## 3. Tarifas de Materiales y Cálculo de Incentivos On-Chain

A diferencia de modelos Web2 tradicionales donde el backend calcula las recompensas, en **Livora el contrato inteligente es la fuente de verdad aritmética**:

| Material | Código `Symbol` | Tarifa por Defecto | Stroops / kg (7 decimales) |
| :--- | :--- | :--- | :--- |
| **PET** | `PET` | 10 ECO / kg | `100,000,000` |
| **Aluminio** | `ALUMINIO` | 15 ECO / kg | `150,000,000` |
| **Cartón** | `CARTON` | 5 ECO / kg | `50,000,000` |
| **Plástico Duro** | `PLASTICO` | 10 ECO / kg | `100,000,000` |
| **Papel** | `PAPEL` | 5 ECO / kg | `50,000,000` |
| **Tetrapak** | `TETRAPAK` | 4 ECO / kg | `40,000,000` |
| **Vidrio** | `VIDRIO` | 3 ECO / kg | `30,000,000` |
| **Otros / Fallback** | — | 5 ECO / kg | `50,000,000` |

---

## 4. Transferencia Delegada con Firma Ed25519 (`transfer_delegated`)

Para permitir que los usuarios domiciliarios canjeen EcoTokens en comercios sin necesidad de mantener saldo de XLM para tarifas de gas, el contrato soporta firmas Ed25519 fuera de cadena:

```rust
pub fn transfer_delegated(
    env: Env,
    caller: Address,
    from: Address,
    to: Address,
    amount: i128,
    nonce: i128,
    public_key_raw: BytesN<32>,
    signature: BytesN<64>,
) -> bool
```

1. **Autorización del Relayer**: Solo el `worker` o el `owner` pueden invocar la función (`caller.require_auth()`).
2. **Validación de Correspondencia**: Se verifica que la dirección Stellar `from` corresponda a la llave pública binaria `public_key_raw`.
3. **Control Anti-Replay (Nonces)**: Se comprueba que `nonce == nonces[from]`, incrementándolo atómicamente.
4. **Reconstrucción del Payload XDR**: Se ensambla `(from, to, amount, nonce, contract_address)` en formato XDR binario.
5. **Verificación Criptográfica Nativa**: Se invoca `env.crypto().ed25519_verify(&public_key_raw, &payload, &signature)`.
6. **Transferencia Interna**: Se debita a `from` y se acredita a `to`.

---

## 5. Compilación y Despliegue

```bash
# Compilar a WebAssembly optimizado
cargo build --target wasm32-unknown-unknown --release

# Despliegue en Stellar Testnet con Soroban CLI
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/ecotoken_registry.wasm \
  --source worker-wallet \
  --network testnet
```
