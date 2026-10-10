# Especificación Técnica y Arquitectura: Módulo de Autenticación y Usuarios (Auth & Users Module)

**Proyecto:** Livora - Backend Sistema de Trazabilidad de Reciclaje  
**Módulo:** `AuthModule` & `UsersModule`  
**Ubicación:** `src/auth/` & `src/users/`  
**Estado:** Producción / Implementado  

---

## 1. Resumen Arquitectónico

El módulo de Autenticación y Gestión de Usuarios de **Livora** adopta un modelo de **Identidad Nativo de Alta Seguridad** basado en **PostgreSQL + Prisma ORM** con hashing Bcrypt (12 rondas OWASP), credenciales aisladas en `UserCredential`, claves custodiales en `WalletVault` y sesiones con refresh tokens rotativos en **Redis**.

```
                    ┌─────────────────────────┐
                    │    Cliente HTTP/App     │
                    └────────────┬────────────┘
                                 │
                   POST /auth/register | /auth/login
                                 ▼
                    ┌─────────────────────────┐
                    │   Livora API Gateway    │
                    │       (NestJS)          │
                    └────┬───────────────┬────┘
                         │               │
     (Credenciales &     │               │   (Sesiones Rotativas)
      WalletVault)       ▼               ▼
            ┌─────────────────────┐     ┌─────────────────────┐
            │ PostgreSQL (Prisma) │     │   Redis Clustered   │
            │ Tablas: `users`,    │     │   Prefijo: session: │
            │ `user_credentials`  │     └─────────────────────┘
            └─────────────────────┘
```

### Principios Clave:
1. **Seguridad y Cero Dependencias de IdP Externos**: El sistema gestiona directamente el almacenamiento seguro de credenciales con Bcrypt (12 rondas OWASP) y emisión/firma de Json Web Tokens (JWT) mediante `TokenService` y `PasswordService`.
2. **Sesiones Rotativas en Redis**: Refresh tokens criptográficos con control de familias de sesión y detección de reuso para revocación inmediata en Redis.
3. **Billetera Custodial Web3 Aislada**: Cada usuario registrado obtiene una billetera **Stellar** (clave pública `G...` y clave secreta `S...`) generada con `@stellar/stellar-sdk` (`Keypair.random()`), cifrada con AES-256-GCM y custodiada en la entidad satélite `WalletVault`.

---

## 2. Modelo de Datos

### Enum: `Role`
Define los roles del sistema de trazabilidad de reciclaje:
- `HOGAR`: Generador domiciliario de residuos.
- `RECOLECTOR`: Agente encargado de la recolección y transporte.
- `CENTRO_ACOPIO`: Centro de recepción, clasificación y acopio.
- `EMPRESA_B2B`: Cliente corporativo o procesador industrial.
- `TIENDA`: Comercio aliado para canjes y cobros POS con EcoTokens.
- `ADMIN`: Administrador global del sistema.

### Modelo Prisma: `User`
Ubicación: `prisma/schema.prisma`

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `String` | `@id @db.Uuid` | ID único criptográfico de la cuenta (UUID v4). |
| `email` | `String` | `@unique` | Correo electrónico del usuario. |
| `role` | `Role` | Enum `Role` | Rol asignado dentro de la plataforma. |
| `walletAddress` | `String?` | `@unique` | Clave pública de la cuenta Stellar (`G...`). |
| `encryptedPrivateKey` | `String?` | Opcional | Clave secreta Stellar (`S...`) encriptada con AES-256-GCM. |
| `createdAt` | `DateTime` | `@default(now())` | Fecha de creación del registro. |
| `updatedAt` | `DateTime` | `@updatedAt` | Fecha de última actualización. |

```prisma
enum Role {
  HOGAR
  RECOLECTOR
  CENTRO_ACOPIO
  EMPRESA_B2B
  ADMIN
  TIENDA
}

model User {
  id                  String   @id @db.Uuid
  email               String   @unique
  role                Role
  walletAddress       String?  @unique
  encryptedPrivateKey String?
  receptionPin        String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  householdRequests CollectionRequest[] @relation("HouseholdRequests")
  collectorRequests CollectionRequest[] @relation("CollectorRequests")

  collectorBatches     Batch[]             @relation("CollectorBatches")
  destinationBatches   Batch[]             @relation("DestinationBatches")
  notifications        Notification[]
  centerConsolidations ConsolidatedBatch[] @relation("CenterConsolidations")
  kycApplications      KycApplication[]
  buyerSales           Sale[]              @relation("BuyerSales")
  centerSales          Sale[]              @relation("CenterSales")
  certificates         Certificate[]
  inventoryItems       InventoryItem[]
  inventoryMovements   InventoryMovement[]
  complaints           Complaint[]

  @@map("users")
}
```

---

## 3. Seguridad y Web3 Custodial

Para permitir la firma automatizada de transacciones y eventos de trazabilidad en la red Web3 sin requerir que el usuario administre directamente sus llaves criptográficas (modo custodial), el sistema realiza el siguiente proceso:

### 3.1. Generación de la Billetera
En `UsersService.create()`, se utiliza `@stellar/stellar-sdk`:
```typescript
const pair = Keypair.random();
const walletAddress = pair.publicKey();
const privateKey = pair.secret();
```

### 3.2. Encriptación Simétrica (AES-256-GCM)
La clave privada nunca se almacena en texto plano. Se procesa mediante el helper `CryptoUtil` (`src/common/utils/crypto.util.ts`):
- **Algoritmo**: `aes-256-gcm`.
- **Vector de Inicialización (IV)**: 12 bytes aleatorios (`crypto.randomBytes(12)`).
- **Tag de Autenticación (AuthTag)**: 16 bytes generados por la cifra en modo GCM.
- **Key Derivation**: SHA-256 de la variable de entorno `WALLET_ENCRYPTION_KEY` (o `WALLET_SECRET_KEY`).
- **Formato Final Almacenado**: `ivHex:authTagHex:ciphertextHex`.

---

## 4. Catálogo de Endpoints Implementados

### 4.1. Registro de Usuario (`POST /auth/register`)

Crea la solicitud de registro, hashea temporalmente el OTP en Redis y solicita la verificación por correo transaccional.

- **URL:** `/auth/register`
- **Método:** `POST`
- **Autenticación:** Pública
- **Body (`RegisterDto`):**
```json
{
  "email": "recolector@livora.com",
  "password": "Password123!",
  "role": "RECOLECTOR"
}
```
- **Validaciones DTO (`class-validator`):**
  - `email`: `@IsEmail()`
  - `password`: `@IsString()`, `@MinLength(8)`
  - `role`: `@IsEnum(Role)`

- **Respuesta Exitosa (`201 Created`):**
```json
{
  "message": "Usuario registrado exitosamente",
  "user": {
    "id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "email": "recolector@livora.com",
    "role": "RECOLECTOR",
    "walletAddress": "GBUQ7ESFDUS66F6CGQZ7J56B6RFXQYODQY5J3SSTZ6T72OBAYHQF5QG6",
    "createdAt": "2026-08-03T21:00:00.000Z",
    "updatedAt": "2026-08-03T21:00:00.000Z"
  }
}
```

---

### 4.2. Inicio de Sesión (`POST /auth/login`)

Autentica las credenciales con Bcrypt contra `UserCredential`, crea una sesión en Redis y retorna los tokens JWT de acceso y refresco rotativo.

- **URL:** `/auth/login`
- **Método:** `POST`
- **Autenticación:** Pública
- **Body (`LoginDto`):**
```json
{
  "email": "recolector@livora.com",
  "password": "Password123!"
}
```
- **Respuesta Exitosa (`200 OK`):**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "v1.mc83...",
  "expiresIn": 3600,
  "tokenType": "bearer",
  "user": {
    "id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "email": "recolector@livora.com",
    "role": "RECOLECTOR",
    "walletAddress": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"
  }
}
```

---

## 5. Guards, Decoradores y Control de Acceso (RBAC)

### 5.1. Estrategia JWT (`JwtStrategy`)
- **Ubicación:** `src/auth/strategies/jwt.strategy.ts`
- Extrae el token enviado en la cabecera HTTP: `Authorization: Bearer <accessToken>`.
- Valida la firma del token utilizando la variable de entorno `JWT_SECRET`.
- Método `validate(payload)`: Extrae `payload.sub` (UUID) y consulta en PostgreSQL a través de `UsersService.findById(payload.sub)` para inyectar el usuario autenticado (incluyendo su `role` y `walletAddress`) en el objeto `request.user`.

### 5.2. Decorador `@Roles(...)`
- **Ubicación:** `src/common/decorators/roles.decorator.ts`
- Permite especificar qué roles tienen acceso a un controlador o método específico.

Ejemplo:
```typescript
@Roles(Role.ADMIN, Role.CENTRO_ACOPIO)
```

### 5.3. Guard de Roles (`RolesGuard`)
- **Ubicación:** `src/common/guards/roles.guard.ts`
- Utiliza `Reflector` para obtener los roles requeridos definidos mediante `@Roles(...)`.
- Verifica si `request.user.role` está contenido dentro de la lista autorizada. Si el usuario no cuenta con el rol, arroja un `ForbiddenException` (`403 Forbidden`).

---

## 6. Variables de Entorno Requeridas

```env
# Database Configuration
DATABASE_URL="postgresql://livora:livora_secret@localhost:5432/livora_db?schema=public"

# Native JWT Authentication
JWT_SECRET=tu_jwt_secret_de_produccion_256_bits

# Web3 Security Configuration
WALLET_ENCRYPTION_KEY=tu_32_byte_secret_key
```
