# Especificación Técnica y Arquitectura: Módulo de Autenticación y Usuarios (Auth & Users Module)

**Proyecto:** Livora - Backend Sistema de Trazabilidad de Reciclaje  
**Módulo:** `AuthModule` & `UsersModule`  
**Ubicación:** `src/auth/` & `src/users/`  
**Estado:** Producción / Implementado  

---

## 1. Resumen Arquitectónico

El módulo de Autenticación y Gestión de Usuarios de **Livora** adopta un modelo de **Identidad Híbrido** combinando la robustez de **Supabase Auth** como Proveedor de Identidad (IdP) gestionado con la flexibilidad de **PostgreSQL + Prisma ORM** para los datos de dominio y trazabilidad.

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
  (Auth Admin & Login)   │               │   (Perfil Local & Billetera)
                         ▼               ▼
            ┌─────────────────┐     ┌─────────────────────┐
            │  Supabase Auth  │     │ PostgreSQL (Prisma) │
            │  (UUID Master)  │     │   Tabla: `users`    │
            └─────────────────┘     └─────────────────────┘
```

### Principios Clave:
1. **Separación de Responsabilidades de Autenticación**: Supabase Auth gestiona el almacenamiento seguro de credenciales, hashing de contraseñas de usuarios y emisión/firma de Json Web Tokens (JWT).
2. **Sincronización de UUID Master**: Al registrar un usuario, el UUID devuelto por Supabase Auth (`user.id`) se utiliza como Primary Key (`id`) de la tabla local `users` en PostgreSQL.
3. **Billetera Custodial Web3 Automática**: Cada usuario registrado obtiene una billetera Ethereum (address y clave privada) generada automáticamente al momento de la creación de su cuenta.

---

## 2. Modelo de Datos

### Enum: `Role`
Define los roles del sistema de trazabilidad de reciclaje:
- `HOGAR`: Generador domiciliario de residuos.
- `RECOLECTOR`: Agente encargado de la recolección y transporte.
- `CENTRO_ACOPIO`: Centro de recepción, clasificación y acopio.
- `EMPRESA_B2B`: Cliente corporativo o procesador industrial.
- `ALMACEN`: Bodega o almacenamiento intermedio.
- `ADMIN`: Administrador global del sistema.

### Modelo Prisma: `User`
Ubicación: `prisma/schema.prisma`

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `String` | `@id @db.Uuid` | ID único sincronizado desde Supabase Auth (UUID v4). |
| `email` | `String` | `@unique` | Correo electrónico del usuario. |
| `role` | `Role` | Enum `Role` | Rol asignado dentro de la plataforma. |
| `walletAddress` | `String?` | `@unique` | Dirección pública de la billetera Ethereum (Web3). |
| `encryptedPrivateKey` | `String?` | Opcional | Clave privada encriptada en formato `iv:authTag:cipher`. |
| `createdAt` | `DateTime` | `@default(now())` | Fecha de creación del registro. |
| `updatedAt` | `DateTime` | `@updatedAt` | Fecha de última actualización. |

```prisma
enum Role {
  HOGAR
  RECOLECTOR
  CENTRO_ACOPIO
  EMPRESA_B2B
  ALMACEN
  ADMIN
}

model User {
  id                  String   @id @db.Uuid
  email               String   @unique
  role                Role
  walletAddress       String?  @unique
  encryptedPrivateKey String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@map("users")
}
```

---

## 3. Seguridad y Web3 Custodial

Para permitir la firma automatizada de transacciones y eventos de trazabilidad en la red Web3 sin requerir que el usuario administre directamente sus llaves criptográficas (modo custodial), el sistema realiza el siguiente proceso:

### 3.1. Generación de la Billetera
En `UsersService.create()`, se utiliza la librería `ethers` v6:
```typescript
const randomWallet = ethers.Wallet.createRandom();
const walletAddress = randomWallet.address;
const privateKey = randomWallet.privateKey;
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

Crea la cuenta en Supabase Auth, genera la billetera Web3 custodial cifrada y guarda el perfil local en PostgreSQL.

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
    "walletAddress": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    "createdAt": "2026-08-03T21:00:00.000Z",
    "updatedAt": "2026-08-03T21:00:00.000Z"
  }
}
```

---

### 4.2. Inicio de Sesión (`POST /auth/login`)

Autentica las credenciales contra Supabase Auth y retorna los tokens JWT junto con el rol del usuario.

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
- Valida la firma del token utilizando la variable de entorno `SUPABASE_JWT_SECRET`.
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

# Supabase Auth Configuration
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
SUPABASE_JWT_SECRET=tu_jwt_secret

# Web3 Security Configuration
WALLET_ENCRYPTION_KEY=tu_32_byte_secret_key
```
