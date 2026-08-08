# Especificación Técnica Oficial: Módulo de Tiendas Aliadas, Canjes y Liquidaciones (StoresModule)

- **Proyecto:** Livora Backend (NestJS)
- **Módulo:** `StoresModule`
- **Versión:** 1.0.0
- **Estado:** Implementado, Auditado y Verificado
- **Fecha:** Agosto 2026

---

## 1. Resumen y Propósito del Módulo

El **Módulo de Tiendas Aliadas (`StoresModule`)** es el componente de Livora encargado de coordinar, gestionar e integrar el flujo de incentivos económicos entre los usuarios del hogar y los comercios locales. El módulo provee tres flujos de negocio principales:

### Flujos de Negocio:
1. **Gestión de Perfil de Tienda (Rol TIENDA):** Permite a los comercios registrar sus datos de facturación (RUC), ubicación física y su información bancaria (incluyendo CCI) para permitir los desembolsos de efectivo en las liquidaciones.
2. **Canje de EcoTokens vía Código QR (Rol TIENDA ↔ Rol HOGAR):**
   - **Generación de QR (Tienda):** Un comercio autorizado (`TIENDA`) especifica un monto de EcoTokens. El backend genera una transacción de canje en estado `PENDING` y produce un identificador único codificado (`qrCodeRef`).
   - **Confirmación de Canje (Hogar):** Un usuario con rol `HOGAR` escanea el código QR en el establecimiento. El backend valida el saldo disponible del hogar mediante consultas on-chain rápidas. Si el saldo es suficiente, la transacción se marca como `COMPLETED`, se asocia el identificador del usuario, se notifica en tiempo real al comercio vía WebSockets y se encola una transacción asíncrona en la cola blockchain para realizar la transferencia física de tokens de billetera a billetera.
3. **Liquidación y Cash-Out (Rol TIENDA ↔ Rol ADMIN):**
   - **Solicitud de Liquidación (Tienda):** El comercio solicita convertir sus EcoTokens acumulados a moneda local (Soles). Se aplica una regla de negocio que restringe las solicitudes a un mínimo de 50 EcoTokens y se calcula una equivalencia de `1 Token = 1 Sol`. La solicitud se crea en estado `PENDING`.
   - **Procesamiento de Pago (Admin):** Un administrador (`ADMIN`) de Livora procesa el pago bancario de forma externa y sube el comprobante digital (`receiptUrl`). El backend cambia el estado de la liquidación a `PAID`, notifica al comercio vía WebSockets y encola un trabajo en la cola blockchain para transferir los EcoTokens correspondientes desde la billetera de la tienda hacia la Billetera de Tesorería de Livora (en lugar de quemarlos).

---

## 2. Actualización del Esquema Prisma

El modelo de datos extiende el esquema de PostgreSQL para soportar comercios, canjes y liquidaciones.

### Enums e Incrementos de Roles
```prisma
enum Role {
  HOGAR
  RECOLECTOR
  CENTRO_ACOPIO
  EMPRESA_B2B
  ALMACEN
  ADMIN
  TIENDA
}

enum RedemptionStatus {
  PENDING
  COMPLETED
  CANCELLED
}

enum SettlementStatus {
  PENDING
  APPROVED_PENDING_PAYMENT
  PAID
  REJECTED
}
```

### Modelo `StoreProfile`
```prisma
model StoreProfile {
  id           String                  @id @default(uuid()) @db.Uuid
  userId       String                  @unique @db.Uuid
  businessName String
  ruc          String
  address      String
  bankAccount  String
  logoUrl      String?
  createdAt    DateTime                @default(now())
  updatedAt    DateTime                @updatedAt

  user         User                    @relation(fields: [userId], references: [id], onDelete: Cascade)
  redemptions  RedemptionTransaction[]
  settlements  SettlementRequest[]

  @@map("store_profiles")
}
```

### Modelo `RedemptionTransaction`
```prisma
model RedemptionTransaction {
  id          String           @id @default(uuid()) @db.Uuid
  storeId     String           @db.Uuid
  userId      String?          @db.Uuid
  tokenAmount Float
  qrCodeRef   String           @unique
  status      RedemptionStatus @default(PENDING)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  store       StoreProfile     @relation(fields: [storeId], references: [id], onDelete: Cascade)
  user        User?            @relation("HouseholdRedemptions", fields: [userId], references: [id], onDelete: SetNull)

  @@map("redemption_transactions")
}
```

### Modelo `SettlementRequest`
```prisma
model SettlementRequest {
  id          String           @id @default(uuid()) @db.Uuid
  storeId     String           @db.Uuid
  tokenAmount Float
  fiatAmount  Float
  status      SettlementStatus @default(PENDING)
  receiptUrl  String?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  store       StoreProfile     @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("settlement_requests")
}
```

---

## 3. Integración Asíncrona y WebSockets

### Integración de Colas con BullMQ (`blockchain-queue`)
Las transacciones on-chain se procesan asíncronamente para evitar cuellos de botella en la respuesta HTTP. El backend añade trabajos con payloads tipados a la cola `blockchain-queue` y el microservicio de blockchain (`BlockchainProcessor`) se encarga de ejecutarlos:

1. **`redemption-transfer` (Canje)**: Mueve los EcoTokens desde la dirección de billetera del hogar (`fromWallet`) hacia la billetera del comercio (`toWallet`).
   - *Payload:* `redemptionId`, `fromUserId`, `toStoreUserId`, `fromWallet`, `toWallet`, `tokenAmount`.
2. **`settlement-transfer` (Liquidación)**: Mueve los EcoTokens desde la billetera del comercio (`fromWallet`) hacia la wallet de Tesorería de Livora (`toWallet`), consolidando el balance.
   - *Payload:* `settlementId`, `fromStoreUserId`, `fromWallet`, `toWallet`, `tokenAmount`.

### Notificaciones en Tiempo Real (WebSockets)
Cuando un comercio se conecta al Gateway de WebSockets, es asignado automáticamente a una sala privada basada en su identificador de usuario:
```typescript
// WebsocketsGateway (handleConnection)
if (role === 'TIENDA') {
  const storeRoom = `store:${userId}`;
  await client.join(storeRoom);
}
```

El servicio `WebsocketsService` provee el método `emitStoreNotification` para alertar al comercio ante los siguientes eventos:
- **`redemption:completed`**: Emitido cuando un hogar escanea exitosamente el QR y confirma el canje. Permite a la tienda actualizar su terminal de ventas en tiempo real sin requerir recargar la página.
- **`settlement:paid`**: Emitido cuando el administrador procesa el pago de una liquidación bancaria y adjunta el comprobante.

---

## 4. Seguridad y Control de Acceso (RBAC)

La autenticación se realiza de manera centralizada mediante `SupabaseAuthGuard` para validar los tokens JWT, y la autorización a través de `RolesGuard` y el decorador `@Roles(...)`.

- **Control de Perfiles**: El perfil de tienda se vincula de manera forzada al identificador del usuario autenticado (`req.user.id`), protegiendo los datos contra suplantaciones.
- **Validaciones de Canjes y Liquidaciones**:
  - Solo los usuarios con rol `TIENDA` pueden crear perfiles de comercio, generar códigos QR e iniciar solicitudes de liquidación.
  - Solo los usuarios con rol `HOGAR` pueden escanear y confirmar códigos QR de canje.
  - Solo los administradores con rol `ADMIN` pueden aprobar solicitudes de pago e inyectar el link del comprobante digital.

---

## 5. Catálogo de Endpoints Implementados

Ruta Base: `/stores`

| Método | Endpoint | Roles Permitidos | Payload Esperado | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/stores/profile` | `TIENDA` | `CreateStoreProfileDto` | Registra los datos del comercio y su cuenta bancaria. |
| **POST** | `/stores/redemptions/qr` | `TIENDA` | `CreateQrRedemptionDto` | Crea un canje pendiente y devuelve el `qrCodeRef` del QR. |
| **POST** | `/stores/redemptions/confirm/:qrCodeRef` | `HOGAR` | N/A | Escanea el QR, valida el saldo del hogar, cambia el estado a `COMPLETED`, notifica al comercio y encola la transferencia on-chain. |
| **POST** | `/stores/settlements` | `TIENDA` | `CreateSettlementRequestDto` | Crea una solicitud de liquidación en estado `PENDING`. Requiere un mínimo de 50 EcoTokens. |
| **PATCH** | `/stores/settlements/:id/pay` | `ADMIN` | `PaySettlementDto` | Marca la liquidación como `PAID`, vincula el comprobante digital, notifica a la tienda y encola el movimiento a Tesorería. |

---

## 6. Guía de Pruebas HTTP

Referencia interactiva para probar el ciclo de vida del módulo de tiendas desde cualquier cliente REST (ej. VS Code REST Client).

```http
### Configuración de Base
@baseUrl = http://localhost:3000
@storeToken = Bearer_JWT_Tienda
@householdToken = Bearer_JWT_Hogar
@adminToken = Bearer_JWT_Admin

### 1. Crear Perfil de Comercio (Rol: TIENDA)
POST {{baseUrl}}/stores/profile
Authorization: Bearer {{storeToken}}
Content-Type: application/json

{
  "businessName": "EcoMarket Miraflores S.A.C.",
  "ruc": "20601122334",
  "address": "Calle Cantuarias 140, Miraflores",
  "bankAccount": "BCP - CCI: 002-191001234567890-54",
  "logoUrl": "https://ecomarket.pe/assets/logo.jpg"
}

### 2. Generar Código QR de Canje (Rol: TIENDA)
POST {{baseUrl}}/stores/redemptions/qr
Authorization: Bearer {{storeToken}}
Content-Type: application/json

{
  "tokenAmount": 15.5
}

### 3. Escanear y Confirmar Canje (Rol: HOGAR)
# Reemplazar {{qrCodeRef}} con el valor obtenido en el paso 2
@qrCodeRef = LIVORA-QR-PLACEHOLDER

POST {{baseUrl}}/stores/redemptions/confirm/{{qrCodeRef}}
Authorization: Bearer {{householdToken}}
Content-Type: application/json

{}

### 4. Solicitar Liquidación (Rol: TIENDA)
# Validación: arrojará error si tokenAmount es menor a 50
POST {{baseUrl}}/stores/settlements
Authorization: Bearer {{storeToken}}
Content-Type: application/json

{
  "tokenAmount": 55.0
}

### 5. Procesar Pago de Liquidación (Rol: ADMIN)
# Reemplazar {{settlementId}} con el UUID del paso 4
@settlementId = SETTLEMENT-ID-PLACEHOLDER

PATCH {{baseUrl}}/stores/settlements/{{settlementId}}/pay
Authorization: Bearer {{adminToken}}
Content-Type: application/json

{
  "receiptUrl": "https://supabase.co/storage/v1/object/public/receipts/comprobante-987.pdf"
}
```
