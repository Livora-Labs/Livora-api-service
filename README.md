# ♻️ Livora — Reciclaje trazable con incentivos Web3 en Arbitrum

**Livora** convierte cada kilo de material reciclado en un hecho verificable on-chain y en un pago automático. Los hogares separan residuos, los recolectores los consolidan en lotes y los centros de acopio los pesan industrialmente; el contrato inteligente en **Arbitrum Stylus** calcula las recompensas a partir de los pesos verificados y mintea **EcoTokens (ECO)** directamente a las billeteras de los participantes.

Proyecto presentado en la **Hackathon Ethereum Lima 2026**.

## 🌐 Enlaces en vivo

| Recurso | URL |
|---|---|
| API en producción (HTTPS) | https://52.200.2.107.sslip.io |
| Swagger — documentación interactiva | https://52.200.2.107.sslip.io/api/docs |
| Arquitectura del sistema | https://52.200.2.107.sslip.io/arquitectura |
| Contrato `EcoBatchRegistry` en Arbitrum Sepolia | https://sepolia.arbiscan.io/address/0xdbe5cc4b3d5a5a1d1f6b1d702367c44a2056c2d8 |
| Demo del cálculo on-chain (evento `BatchWeighed`) | https://sepolia.arbiscan.io/tx/0x54e8f64b6c6d0e3a8738b4a0ddc862a07601ce8c386deaf995d5dbb829b4caba |

## 🏗️ Arquitectura

```
Apps (HOGAR / RECOLECTOR / CENTRO)
        │  REST + JWT · WebSockets
        ▼
API Gateway NestJS ──► Supabase Auth (IdP) · PostgreSQL+PostGIS (Prisma) · Redis (BullMQ)
        │  pesaje industrial → HTTP 202 + job encolado
        ▼
Worker asíncrono ──► IPFS/Pinata (manifiesto → CID)
        │
        ▼
Arbitrum Stylus · EcoBatchRegistry (Rust→WASM)
   tarifas × peso · split 80/20 · minteo ERC-20 atómico
        │
        ▼
PostgreSQL (estado RECEIVED) + notificación Socket.IO en tiempo real
```

El cálculo de incentivos ocurre **dentro del contrato**: el backend solo reporta pesos en gramos y el contrato aplica las tarifas por material (PET 10 ECO/kg, aluminio 15, vidrio 3…) y la distribución 80% hogares / 20% recolector, emitiendo el evento `BatchWeighed` como auditoría pública. Detalle completo en la [página de arquitectura](https://52.200.2.107.sslip.io/arquitectura) y en [`docs/specs/`](docs/specs/).

## 🧰 Stack

NestJS 11 · TypeScript · Prisma · PostgreSQL 16 + PostGIS · Redis 7 + BullMQ · Socket.IO · Supabase Auth · Ethers.js v6 · IPFS (Pinata) · **Rust + Arbitrum Stylus SDK** · Docker

## 🚀 Instalación y ejecución local

### Requisitos previos

- Node.js 22+
- Docker y Docker Compose
- (Solo para el contrato) Rust 1.90 + `cargo-stylus` 0.10.2

### 1. Clonar e instalar dependencias

```bash
git clone https://github.com/Livora-Labs/Livora-api-service.git
cd Livora-api-service
npm install
```

### 2. Levantar PostgreSQL y Redis

```bash
docker compose up -d
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Completar en `.env`:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Conexión a Postgres (el compose local expone el puerto definido en `DB_PORT`) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_JWT_SECRET` | Proyecto de Supabase Auth (gratuito) |
| `WALLET_ENCRYPTION_KEY` | Clave de 32 bytes para cifrar las billeteras custodiales |
| `ARBITRUM_RPC_URL` | RPC de Arbitrum Sepolia: `https://sepolia-rollup.arbitrum.io/rpc` |
| `WORKER_PRIVATE_KEY` | Clave privada de la wallet que firma las transacciones (necesita ETH de Sepolia del [faucet](https://faucet.quicknode.com/arbitrum/sepolia)) |
| `ECOTOKEN_CONTRACT_ADDRESS` | Contrato desplegado (ya incluido en `.env.example`) |
| `PINATA_API_KEY` / `PINATA_SECRET_KEY` | Credenciales de [Pinata](https://pinata.cloud) para IPFS (con fallback en desarrollo si faltan) |

### 4. Sincronizar el esquema de base de datos

```bash
npx prisma db push
npx prisma generate
```

### 5. Arrancar el API

```bash
npm run start:dev
```

Swagger disponible en `http://localhost:3000/api/docs`. Los archivos `*.http` de la raíz (`auth-test.http`, `collections-test.http`, `batches-test.http`, `stores-test.http`) contienen requests de ejemplo de los flujos completos.

### Pruebas

```bash
npm run test        # unitarias
npm run test:e2e    # end-to-end
```

## ⛓️ Contrato inteligente (Arbitrum Stylus)

Ubicación: [`contracts/ecotoken_registry/`](contracts/ecotoken_registry/) — Rust compilado a WASM con el Stylus SDK. Fusiona el token ERC-20 **EcoToken** con el registro inmutable de lotes y el **cálculo de incentivos on-chain** (`register_batch_weighed`).

```bash
# Toolchain
rustup toolchain install 1.90.0
rustup target add wasm32-unknown-unknown --toolchain 1.90.0
cargo +1.90.0 install cargo-stylus --version 0.10.2 --locked

cd contracts/ecotoken_registry

# Compilar y validar
cargo check --target wasm32-unknown-unknown
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc

# Desplegar (requiere ETH de Sepolia en la wallet)
cargo stylus deploy \
  --endpoint https://sepolia-rollup.arbitrum.io/rpc \
  --private-key $WORKER_PRIVATE_KEY \
  --no-verify --max-fee-per-gas-gwei 0.5
```

Tras el deploy, llamar `init(workerAddress)` (siembra las tarifas por material y fija el split 80/20) y actualizar `ECOTOKEN_CONTRACT_ADDRESS` en `.env`.

## ☁️ Despliegue en producción

- **AWS Lightsail (actual):** `docker-compose.prod.yml` levanta API + Postgres/PostGIS + Redis + Caddy (TLS automático con Let's Encrypt). Deploy con un comando: `./deploy-lightsail.sh <IP> <llave.pem>`.
- **Render (alternativo):** configuración lista en `render.yaml`.

## 📁 Estructura del proyecto

```
src/
├── auth/ users/          # Identidad híbrida Supabase + billeteras custodiales
├── collections/          # Solicitudes de recolección · matching por proximidad (PostGIS)
├── batches/              # Lotes: consolidación, tránsito, pesaje, idempotencia
├── blockchain/           # Worker BullMQ: IPFS → pesos → contrato Stylus
├── websockets/           # Notificaciones en tiempo real (Socket.IO + Redis adapter)
├── stores/ b2b/ sales/   # Canje QR, liquidaciones, transferencias B2B, ventas
└── inventory/ centers/   # Inventario por centro y conservación de masa
contracts/
└── ecotoken_registry/    # Contrato Stylus en Rust (ERC-20 + registro + cálculo on-chain)
docs/specs/               # Especificaciones técnicas por módulo
```

## 👥 Equipo

**Livora Labs** — Hackathon Ethereum Lima 2026.
