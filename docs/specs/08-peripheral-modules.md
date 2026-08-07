# Especificación Técnica Oficial: Módulos Periféricos (`MetricsModule`, `AdminModule`, `SalesModule`, `InventoryModule`)

- **Proyecto:** Livora Backend (NestJS API Gateway)
- **Módulos:** `MetricsModule`, `AdminModule`, `SalesModule`, `InventoryModule`
- **Versión:** 1.0.0
- **Estado:** Implementado, Auditado y Verificado
- **Fecha:** Agosto 2026

---

## 1. Resumen y Propósito de los Módulos Periféricos

Los **Módulos Periféricos** completan el 100% de la cobertura del catálogo de APIs de Livora, proporcionando la capa administrativa, de reporte ESG, gestión comercial B2B y control de inventario físico en planta:

1. **Módulo de Métricas y Reportes (`MetricsModule`):**
   - Proporciona métricas agregadas de reciclaje e impacto ambiental para **Hogares** (solicitudes completadas, kg reciclados, EcoTokens ganados), **Recolectores** (reputación, score y badges), **Empresas B2B** (ahorro de CO2, agua y certificados) y **Administrador Global** (resumen ejecutivo del sistema).

2. **Módulo de Administración & KYC (`AdminModule` / `KycModule`):**
   - Gestiona el proceso de verificación de identidad (**KYC**) para recolectores, solicitudes de registro comercial B2B, cambio de estado de usuarios (baneo/activación), monitoreo de salud de la red Blockchain y atención de quejas o reclamos (`Complaint`).

3. **Módulo B2B & Ventas (`SalesModule` / `B2bModule`):**
   - Permite a los Centros de Acopio registrar la venta industrial de material reciclado procesado a Empresas B2B (`Sale`).
   - Emite y consulta Certificados ESG de Impacto Ambiental (`Certificate`) asociados a compras corporativas.

4. **Módulo de Almacén e Inventario (`InventoryModule`):**
   - Controla el stock físico de materiales en planta (`InventoryItem`) y registra todos los movimientos de entrada y salida (`InventoryMovement`) bajo transacciones atómicas ACID.

---

## 2. Actualizaciones del Esquema de Datos (Prisma Schema)

Los módulos periféricos introducen 6 nuevos modelos en PostgreSQL a través de Prisma:

```prisma
enum KycStatus {
  PENDING
  APPROVED
  REJECTED
}

model KycApplication {
  id          String    @id @default(uuid()) @db.Uuid
  status      KycStatus @default(PENDING)
  documentUrl String?
  userId      String    @db.Uuid
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("kyc_applications")
}

model Sale {
  id          String   @id @default(uuid()) @db.Uuid
  weightKg    Float
  totalAmount Float
  buyerId     String   @db.Uuid
  centerId    String   @db.Uuid
  createdAt   DateTime @default(now())

  buyer  User @relation("BuyerSales", fields: [buyerId], references: [id])
  center User @relation("CenterSales", fields: [centerId], references: [id])

  @@map("sales")
}

enum CertificateStatus {
  ACTIVE
  REVOKED
}

model Certificate {
  id        String            @id @default(uuid()) @db.Uuid
  status    CertificateStatus @default(ACTIVE)
  ipfsHash  String
  esgImpact Json
  buyerId   String            @db.Uuid
  createdAt DateTime          @default(now())

  buyer User @relation(fields: [buyerId], references: [id])

  @@map("certificates")
}

enum MovementType {
  IN
  OUT
}

model InventoryItem {
  id           String   @id @default(uuid()) @db.Uuid
  materialType String
  quantityKg   Float
  centerId     String   @db.Uuid
  updatedAt    DateTime @updatedAt

  center User @relation(fields: [centerId], references: [id])

  @@map("inventory_items")
}

model InventoryMovement {
  id           String       @id @default(uuid()) @db.Uuid
  type         MovementType
  quantityKg   Float
  materialType String
  centerId     String       @db.Uuid
  createdAt    DateTime     @default(now())

  center User @relation(fields: [centerId], references: [id])

  @@map("inventory_movements")
}

enum ComplaintStatus {
  OPEN
  IN_PROGRESS
  RESOLVED
  CLOSED
}

model Complaint {
  id          String          @id @default(uuid()) @db.Uuid
  subject     String
  description String
  status      ComplaintStatus @default(OPEN)
  userId      String          @db.Uuid
  createdAt   DateTime        @default(now())
  updatedAt   DateTime        @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("complaints")
}
```

---

## 3. Estrategia de Mocks (Simulación sin Dependencias Externas)

Bajo la **Regla de Oro** de cero dependencias o servicios externos adicionales:

1. **Métricas ESG e Impacto:** Los KPIs ambientales para el rol `EMPRESA_B2B` y `HOGAR` se calculan mediante algoritmos locales basados en multiplicadores de conversión ecológica por material (ej. `kg * 2.5 CO2` ahorrado, `kg * 10 Litros` de agua) o datos agregados de base de datos (`CollectionRequest`, `Batch`, `Sale`).
2. **Salud de la Blockchain (`GET /admin/blockchain/health`):** Retorna un payload JSON estático con métricas de salud simuladas (`healthy`, latencia en ms, bloque actual) manteniendo compatibilidad completa con el dashboard de administración.
3. **Emisión de Certificados ESG con Hash IPFS (`POST /certificates`):** Simula el minteo de certificados generando un identificador de contenido inmutable determinista (`ipfs://QmFakeCertificateIpfsHash...`) que se almacena en la tabla `Certificate` sin requerir invocación externa a Pinata o nodos IPFS.

---

## 4. Catálogo de Endpoints Implementados

| Método | Ruta | Roles Permitidos | Descripción |
| :--- | :--- | :--- | :--- |
| **`GET`** | `/households/me/metrics` | `HOGAR` | Obtiene resumen de solicitudes, kg reciclados y EcoTokens ganados. |
| **`GET`** | `/collectors/me/reputation` | `RECOLECTOR` | Obtiene score de reputación, total de recolecciones y distintivo. |
| **`GET`** | `/b2b/me/esg-metrics` | `EMPRESA_B2B` | Obtiene KPIs de impacto ambiental ESG (CO2, agua, material). |
| **`GET`** | `/admin/metrics` | `ADMIN` | Obtiene resumen global del sistema y usuarios registrados. |
| **`POST`** | `/collectors/kyc-applications` | `RECOLECTOR` | Envía solicitud de verificación KYC con URL de documento. |
| **`POST`** | `/b2b/applications` | *Público* | Registra solicitud de vinculación comercial para empresas B2B. |
| **`GET`** | `/admin/kyc-applications` | `ADMIN` | Lista las solicitudes de verificación KYC pendientes (paginado). |
| **`PATCH`** | `/users/:id/kyc-status` | `ADMIN` | Aprueba o rechaza el estado KYC de un usuario. |
| **`PATCH`** | `/users/:id/status` | `ADMIN` | Activa o inhabilita (bano) el acceso de un usuario. |
| **`GET`** | `/admin/blockchain/health` | `ADMIN` | Retorna reporte de salud y latencia del nodo Blockchain. |
| **`PATCH`** | `/complaints/:id` | `ADMIN` | Actualiza el estado de resolución de un reclamo/queja. |
| **`POST`** | `/sales` | `CENTRO_ACOPIO` | Registra una venta industrial de material a una Empresa B2B. |
| **`GET`** | `/certificates` | `EMPRESA_B2B` | Lista los certificados ESG emitidos para la empresa autenticada. |
| **`GET`** | `/certificates/:id` | `EMPRESA_B2B` | Consulta el detalle de un certificado ESG por su ID. |
| **`POST`** | `/certificates` | `ADMIN` | Genera y emite un certificado ESG simulado guardando hash IPFS en BD. |
| **`GET`** | `/inventory` | `CENTRO_ACOPIO`, `ALMACEN`, `ADMIN` | Consulta el stock físico de materiales en planta/almacén. |
| **`POST`** | `/inventory/movements` | `CENTRO_ACOPIO`, `ALMACEN` | Registra entrada/salida de inventario y actualiza stock atómicamente. |

---

## 5. Seguridad y Estándares Globales

1. **Guardias de Autenticación y Roles:** Todos los endpoints protegidos incorporan `@UseGuards(SupabaseAuthGuard, RolesGuard)` y el decorador custom `@Roles(Role.XYZ)`.
2. **Documentación Swagger:** Cada método está decorado con `@ApiTags()`, `@ApiBearerAuth()` y `@ApiOperation()` para la documentación interactiva en `/api/docs`.
3. **Manejo de Excepciones:** Todas las respuestas de error son interceptadas por el `GlobalExceptionFilter`, garantizando el envoltorio `{ "error": { "code", "message", "details" } }`.
4. **Paginación:** Los endpoints de lectura masiva utilizan `PaginationQueryDto` para el control de `page`, `limit`, `sortBy` y `sortOrder`.
