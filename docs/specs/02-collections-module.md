# Especificación Técnica Oficial: Módulo de Recolección (CollectionsModule)

- **Proyecto:** Livora Backend (NestJS Monorepo)
- **Módulo:** `CollectionsModule`
- **Versión:** 1.0.0
- **Estado:** Implementado, Auditado y Verificado
- **Fecha:** Agosto 2026

---

## 1. Resumen y Propósito del Módulo

El **Módulo de Recolección (`CollectionsModule`)** es el componente central de Livora encargado de coordinar y gestionar el ciclo de vida de las solicitudes de reciclaje entre los usuarios finales (**HOGAR**) y los recolectores de material (**RECOLECTOR**).

### Flujo de Negocio:
1. **Creación de Solicitud (Rol HOGAR):** Un usuario con rol `HOGAR` registra una solicitud especificando la ubicación geográfica (`latitude`, `longitude`), la estimación de materiales en kg (`itemsEstimated`), una descripción opcional y una fotografía del material. La solicitud se crea con un **PIN aleatorio de 4 dígitos** para verificación presencial y en estado `PENDING`.
2. **Búsqueda por Proximidad (Rol RECOLECTOR):** Los recolectores autenticados pueden consultar las solicitudes pendientes cercanas a su ubicación enviando sus coordenadas y un radio de búsqueda en kilómetros. El sistema utiliza **PostGIS (`ST_DistanceSphere`)** para calcular distancias esféricas en tiempo real.
3. **Gestión de Estados:**
   - **Aceptar:** Un recolector cambia el estado a `ACCEPTED`, quedando asignado a la solicitud (`collectorId`).
   - **Cancelar:** El hogar creador puede cancelar la solicitud (`CANCELLED`) mientras no haya sido completada o cancelada previamente.

---

## 2. Actualización del Esquema Prisma

El modelo de base de datos utiliza PostgreSQL con la extensión espacial PostGIS.

### Enum `RequestStatus`
```prisma
enum RequestStatus {
  PENDING
  ACCEPTED
  COMPLETED
  CANCELLED
}
```

### Modelo `CollectionRequest`
```prisma
model CollectionRequest {
  id              String        @id @default(uuid()) @db.Uuid
  status          RequestStatus @default(PENDING)
  itemsEstimated  Json
  photoUrl        String?
  description     String?
  verificationPin String
  latitude        Float
  longitude       Float
  householdId     String        @db.Uuid
  collectorId     String?       @db.Uuid
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  household User  @relation("HouseholdRequests", fields: [householdId], references: [id])
  collector User? @relation("CollectorRequests", fields: [collectorId], references: [id])

  @@map("collection_requests")
}
```

### Relaciones en el Modelo `User`
```prisma
model User {
  // ... campos de usuario
  householdRequests CollectionRequest[] @relation("HouseholdRequests")
  collectorRequests CollectionRequest[] @relation("CollectorRequests")

  @@map("users")
}
```

### Migración de Base de Datos
```bash
npx prisma migrate dev --name init_collections
```

---

## 3. Arquitectura Geoespacial (PostGIS)

Para la búsqueda por cercanía, el servicio `CollectionsService` ejecuta consultas crudas en PostgreSQL optimizadas con PostGIS mediante `prisma.$queryRaw`.

### Consulta SQL Geoespacial
```sql
SELECT 
  id, 
  status, 
  "itemsEstimated", 
  "photoUrl", 
  description, 
  "verificationPin", 
  latitude, 
  longitude, 
  "householdId", 
  "collectorId", 
  "createdAt", 
  "updatedAt",
  ST_DistanceSphere(
    ST_MakePoint(longitude, latitude),
    ST_MakePoint(${lng}, ${lat})
  ) AS distance
FROM collection_requests
WHERE status = 'PENDING'::"RequestStatus"
  AND ST_DistanceSphere(
    ST_MakePoint(longitude, latitude),
    ST_MakePoint(${lng}, ${lat})
  ) <= ${radiusInMeters}
ORDER BY distance ASC;
```

### Puntos Clave de la Implementación Espacial:
- **Orden Eje X/Y en `ST_MakePoint`:** PostGIS exige el orden `ST_MakePoint(longitud, latitud)` (X representa longitud, Y representa latitud).
- **Conversión de Unidades:** `ST_DistanceSphere` retorna distancias en metros. El parámetro de consulta `radius` (en km) se multiplica por `1000` (`radiusInMeters = radius * 1000`).
- **Seguridad contra Inyección SQL:** Los valores interpolados `${lng}`, `${lat}` y `${radiusInMeters}` dentro del tagged template string de `prisma.$queryRaw` son parametrizados como sentencias preparadas de PostgreSQL (`$1`, `$2`, `$3`), garantizando protección total contra ataques de inyección SQL.

---

## 4. Seguridad y Control de Acceso (RBAC)

La seguridad del módulo se basa en el sistema de autenticación de Supabase (JWT) combinado con un Control de Acceso Basado en Roles (RBAC).

### Guards Aplicados
1. **`SupabaseAuthGuard`:** Valida que la petición incluya un token JWT de Supabase válido en el encabezado `Authorization: Bearer <token>` y parsea los datos del usuario a `req.user`.
2. **`RolesGuard`:** Compara los roles definidos en la ruta mediante el decorador `@Roles(...)` con el rol registrado en el usuario autenticado (`req.user.role`).

### Decoradores Personalizados
- **`@Roles(...roles: Role[])`:** Asigna la metadata de roles requeridos en controladores o métodos (`src/common/decorators/roles.decorator.ts`).
- **`@CurrentUser()`:** Extrae directamente el objeto usuario o propiedades específicas del payload autenticado (`src/common/decorators/current-user.decorator.ts`).

---

## 5. Catálogo de Endpoints Implementados

Ruta Base: `/collection-requests`

| Método | Endpoint | Roles Permitidos | Tipo de Contenido | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/collection-requests` | `HOGAR` | `multipart/form-data` \| `application/json` | Crea una solicitud de recolección en estado `PENDING` y genera un PIN de 4 dígitos. |
| **GET** | `/collection-requests` | `HOGAR`, `RECOLECTOR` | N/A | `HOGAR`: Retorna su historial de solicitudes.<br>`RECOLECTOR`: Retorna solicitudes pendientes filtradas por proximidad (`lat`, `lng`, `radius`). |
| **PATCH** | `/collection-requests/:id` | `HOGAR`, `RECOLECTOR` | `application/json` | `RECOLECTOR`: Acepta solicitud (`ACCEPTED`).<br>`HOGAR`: Cancela su solicitud (`CANCELLED`). |

---

## 6. Guía de Pruebas HTTP

Referencia directa para los equipos de **Frontend** y **QA** para interactuar con el backend.

```http
### Variables de Entorno
@baseUrl = http://localhost:3000
@hogarToken = Bearer_JWT_Hogar
@recolectorToken = Bearer_JWT_Recolector
@requestId = 123e4567-e89b-12d3-a456-426614174000

### 1. Crear Solicitud de Recolección (Rol HOGAR)
POST {{baseUrl}}/collection-requests
Authorization: Bearer {{hogarToken}}
Content-Type: application/json

{
  "itemsEstimated": {
    "PET": 2.5,
    "Carton": 4.0,
    "Vidrio": 1.2
  },
  "description": "Bolsa blanca con botellas PET y cartón comprimido cerca a la puerta principal.",
  "latitude": 4.60971,
  "longitude": -74.08175
}

### 2. Buscar Solicitudes Pendientes Cercanas por Proximidad PostGIS (Rol RECOLECTOR)
GET {{baseUrl}}/collection-requests?lat=4.60970&lng=-74.08170&radius=5
Authorization: Bearer {{recolectorToken}}

### 3. Aceptar una Solicitud (Rol RECOLECTOR)
PATCH {{baseUrl}}/collection-requests/{{requestId}}
Authorization: Bearer {{recolectorToken}}
Content-Type: application/json

{
  "status": "ACCEPTED"
}

### 4. Cancelar una Solicitud (Rol HOGAR)
PATCH {{baseUrl}}/collection-requests/{{requestId}}
Authorization: Bearer {{hogarToken}}
Content-Type: application/json

{
  "status": "CANCELLED"
}
```
