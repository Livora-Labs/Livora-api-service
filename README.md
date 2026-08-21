# ♻️ Livora — Reciclaje trazable con incentivos Web3 en Stellar

**Livora** convierte cada kilo de material reciclado en un hecho verificable on-chain y en un pago automático. Los hogares separan residuos, los recolectores los consolidan en lotes y los centros de acopio los pesan industrialmente; el contrato inteligente en **Stellar Soroban** calcula las recompensas a partir de los pesos verificados y mintea **EcoTokens (ECO)** directamente a las billeteras de los participantes.

Proyecto presentado en la **Hackathon Ethereum Lima 2026** (transicionado a Stellar/Soroban para producción).

---

## 🌐 Enlaces en vivo

| Recurso | URL |
|---|---|
| API en producción (HTTPS) | https://52.200.2.107.sslip.io |
| Swagger — documentación interactiva | https://52.200.2.107.sslip.io/api/docs |
| Arquitectura del sistema | https://52.200.2.107.sslip.io/arquitectura |
| Contrato `EcoBatchRegistry` en Stellar Testnet | https://stellar.expert/explorer/testnet/contract/CDTSHH6HOZZ76PNILNWCR63PAM5UDS7FGA3QWZOBP6UYN2WU4PC6GLOJ |

---

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
Stellar Soroban · EcoBatchRegistry (Rust→WASM)
   tarifas × peso · split 80/20 · minteo SEP-41 atómico
        │
        ▼
PostgreSQL (estado RECEIVED) + notificación Socket.IO en tiempo real
```

El cálculo de incentivos ocurre **dentro del contrato**: el backend solo reporta pesos en gramos y el contrato aplica las tarifas por material (PET 10 ECO/kg, aluminio 15, vidrio 3…) y la distribución 80% hogares / 20% recolector, emitiendo eventos como auditoría pública. Detalle completo en la [página de arquitectura](https://52.200.2.107.sslip.io/arquitectura) y en [`docs/specs/`](docs/specs/).

---

## 🧰 Stack

NestJS 11 · TypeScript · Prisma · PostgreSQL 16 + PostGIS · Redis 7 + BullMQ · Socket.IO · Supabase Auth · **@stellar/stellar-sdk** · IPFS (Pinata) · **Rust + Soroban SDK** · Docker

---

## 🚀 Instalación y ejecución local

### Requisitos previos

- Node.js 22+
- Docker y Docker Compose
- (Solo para el contrato) Rust 1.90+ y target `wasm32-unknown-unknown`

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
| `STELLAR_RPC_URL` | RPC de Stellar/Soroban Testnet: `https://soroban-testnet.stellar.org` |
| `STELLAR_HORIZON_URL` | Horizon de Stellar Testnet: `https://horizon-testnet.stellar.org` |
| `WORKER_SECRET_KEY` | Semilla secreta (`S...`) de la wallet pagadora de transacciones (fondeada con Friendbot) |
| `ECOTOKEN_CONTRACT_ID` | Contract ID del contrato Soroban desplegado (starts with `C...`) |
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
```

---

## ⛓️ Contrato inteligente (Stellar Soroban)

Ubicación: [`contracts/ecotoken_registry/`](contracts/ecotoken_registry/) — Rust compilado a WASM con el SDK de Soroban. Implementa un token compatible con **SEP-41** (Token) junto al registro inmutable de lotes y el **cálculo de incentivos on-chain** (`EcoBatchRegistry`).

```bash
# Target de compilación
rustup target add wasm32-unknown-unknown --toolchain 1.90.0

cd contracts/ecotoken_registry

# Compilar
cargo build --target wasm32-unknown-unknown --release
```

El contrato compilado se encuentra en `target/wasm32-unknown-unknown/release/ecotoken_registry.wasm` (Tamaño optimizado: **15.4 KB**).

---

## ☁️ Despliegue en producción

- **AWS Lightsail:** `docker-compose.prod.yml` levanta API + Postgres/PostGIS + Redis + Caddy (TLS automático con Let's Encrypt). Deploy con un comando: `./deploy-lightsail.sh <IP> <llave.pem>`.

---

## 👥 Equipo

**Livora Labs** — Ecosistema Livora 2026.
