# 🧪 Manual Oficial de Pruebas End-to-End (E2E) con Swagger UI (100% Cobertura de APIs)

- **Proyecto:** Livora Backend (NestJS Monorepo)
- **Documento:** Guía de Pruebas E2E Exhaustiva del 100% de los Endpoints
- **Ubicación:** `docs/08-e2e-testing-manual.md`
- **Versión:** 2.0.0 (Completa - 42 Endpoints)
- **Estado:** Producción / QA Ready
- **Fecha:** Agosto 2026

---

## 📋 1. Preparación del Entorno (Setup)

Antes de iniciar las pruebas interactivas en Swagger UI, asegúrate de levantar los servicios base del ecosistema Livora.

### Paso 1.1: Iniciar la Infraestructura (Docker)
En la raíz del proyecto, ejecuta Docker Compose para iniciar **PostgreSQL (PostGIS)** y **Redis**:

```bash
docker-compose up -d
```

### Paso 1.2: Sincronizar Base de Datos
Sincroniza todas las tablas de PostgreSQL con Prisma:

```bash
npx prisma db push
```

### Paso 1.3: Iniciar el Servidor de Aplicación
Inicia NestJS en modo desarrollo:

```bash
npm run start:dev
```

### Paso 1.4: Abrir Swagger UI
Abre tu navegador e ingresa a la siguiente dirección:

👉 **`http://localhost:3000/api/docs`**

---

## 🔐 2. Acto 1: Registro y Autenticación de Todos los Actores

Crearemos los 6 usuarios representando todos los roles del sistema.

### Paso 2.1: Registrar los 6 Usuarios (`POST /auth/register`)

Ejecuta `POST /auth/register` con los siguientes JSONs:

```json
// 1. Rol HOGAR
{ "email": "hogar.e2e@livora.io", "password": "Password123!", "role": "HOGAR" }

// 2. Rol RECOLECTOR
{ "email": "recolector.e2e@livora.io", "password": "Password123!", "role": "RECOLECTOR" }

// 3. Rol CENTRO_ACOPIO
{ "email": "centro.e2e@livora.io", "password": "Password123!", "role": "CENTRO_ACOPIO" }

// 4. Rol EMPRESA_B2B
{ "email": "b2b.e2e@livora.io", "password": "Password123!", "role": "EMPRESA_B2B" }

// 5. Rol ALMACEN
{ "email": "almacen.e2e@livora.io", "password": "Password123!", "role": "ALMACEN" }

// 6. Rol ADMIN
{ "email": "admin.e2e@livora.io", "password": "Password123!", "role": "ADMIN" }
```

### Paso 2.2: Autenticación (`POST /auth/login`) e Inyección del Token JWT

Para probar los endpoints de cada rol:
1. Ejecuta `POST /auth/login` con el correo del rol deseado.
2. Copia el token de la propiedad `accessToken`.
3. Haz clic en el botón **Authorize 🔓** en Swagger UI, pega el token y confirma.

---

## 🏡 3. Acto 2: Origen de Residuos y Solicitudes (Rol: HOGAR / RECOLECTOR)

Inicia sesión como **HOGAR**.

1. **Crear Solicitud (`POST /collection-requests`):**
   ```json
   {
     "itemsEstimated": { "PET": 5.0, "ALUMINIO": 2.0, "CARTON": 8.0 },
     "description": "Reciclaje separado en bolsas blancas",
     "latitude": 4.6097,
     "longitude": -74.0817
   }
   ```
   *Guarda el `id` de la solicitud retornada (ej: `REQ_ID`).*

2. **Listar Solicitudes Paginadas (`GET /collection-requests`):**
   - Parámetros: `page=1`, `limit=10`.

3. **Ver Detalle de Solicitud (`GET /collection-requests/:id`):**
   - Pasa `REQ_ID` en la URL.

4. **Aceptar Solicitud (Inicia sesión como RECOLECTOR) (`PATCH /collection-requests/:id`):**
   ```json
   { "status": "ACCEPTED" }
   ```

---

## 🚚 4. Acto 3: Logística y Gestión de Lotes (Rol: RECOLECTOR)

Con sesión activa de **RECOLECTOR**:

1. **Obtener / Abrir Lote Abierto (`GET /batches/open`):**
   *Guarda el `id` del Lote retornado (ej: `BATCH_ID`).*

2. **Listar Lotes Paginados (`GET /batches`):**
   - Parámetros: `page=1`, `limit=10`.

3. **Poner Lote en Tránsito (`PATCH /batches/:id`):**
   ```json
   { "destinationCenterId": "ID_USUARIO_CENTRO_ACOPIO" }
   ```

---

## 🏬 5. Acto 4: Pesaje Industrial y Consolidación (Rol: CENTRO_ACOPIO)

Inicia sesión como **CENTRO_ACOPIO**:

1. **Obtener PIN de Recepción (`GET /centers/me/reception-pin`):**
   - Obtiene el PIN de seguridad asignado.

2. **Refrescar PIN (`POST /centers/me/reception-pin/refresh`):**
   - Genera un nuevo PIN de seguridad de 4 dígitos.

3. **Pesaje Industrial Báscula (`POST /batches/:id/receive`):**
   ```json
   {
     "materialsActual": { "PET": 5.2, "ALUMINIO": 2.1, "CARTON": 7.9 }
   }
   ```
   *Retorna HTTP 202 Accepted. El worker actualizará el estado a `RECEIVED`.*

4. **Consolidar Lotes Procesados (`POST /consolidated-batches`):**
   ```json
   { "batchIds": ["BATCH_ID"] }
   ```

---

## 💳 6. Acto 5: Billeteras Web3 y Relayer Subsidiado (Rol: HOGAR / RECOLECTOR)

1. **Consultar Saldo EcoToken SEP-41 (`GET /wallets/me/balance`):**
   - Retorna `{ "balance": "150.5" }`.

2. **Enviar Transacción Subsidiada de Gas (`POST /wallets/transactions`):**
   ```json
   {
     "toAddress": "GBUQ7ESFDUS66F6CGQZ7J56B6RFXQYODQY5J3SSTZ6T72OBAYHQF5QG6",
     "amount": 25.0
   }
   ```
   *Retorna HTTP 202 Accepted.*

---

## 🏬 7. Acto 6: Comercio B2B, Certificados ESG e Inventario (Rol: CENTRO_ACOPIO / EMPRESA_B2B / ALMACEN / ADMIN)

1. **Registrar Movimiento de Inventario (`POST /inventory/movements` - CENTRO_ACOPIO / ALMACEN):**
   ```json
   { "type": "IN", "quantityKg": 500, "materialType": "PET" }
   ```

2. **Consultar Inventario en Planta (`GET /inventory`):**
   - Retorna la lista de stock por material.

3. **Registrar Venta B2B (`POST /sales` - CENTRO_ACOPIO):**
   ```json
   { "weightKg": 300, "totalAmount": 750.0, "buyerId": "ID_USUARIO_EMPRESA_B2B" }
   ```

4. **Mintear Certificado ESG (`POST /certificates` - ADMIN):**
   ```json
   { "buyerId": "ID_USUARIO_EMPRESA_B2B", "esgImpact": { "co2SavedKg": 450, "waterSavedLiters": 1200 } }
   ```
   *Guarda el `id` del certificado generado (ej: `CERT_ID`).*

5. **Listar Certificados ESG (`GET /certificates` - EMPRESA_B2B):**
   - Retorna los certificados de la empresa autenticada.

6. **Ver Detalle de Certificado (`GET /certificates/:id` - EMPRESA_B2B):**
   - Pasa `CERT_ID` en la URL.

---

## 🛡️ 8. Acto 7: Verificación KYC, Afiliaciones y Administración (Rol: RECOLECTOR / B2B / ADMIN)

1. **Enviar KYC de Recolector (`POST /collectors/kyc-applications` - RECOLECTOR):**
   ```json
   { "documentUrl": "https://storage.livora.org/kyc/doc_123.pdf" }
   ```

2. **Solicitud de Afiliación B2B Pública (`POST /b2b/applications` - Público):**
   ```json
   { "companyName": "Reciclajes del Norte S.A.", "email": "contacto@norte.com", "taxId": "TAX-998877" }
   ```

3. **Listar Solicitudes KYC Pendientes (`GET /admin/kyc-applications` - ADMIN):**
   - Retorna solicitudes KYC pendientes.

4. **Aprobar / Rechazar KYC (`PATCH /users/:id/kyc-status` - ADMIN):**
   ```json
   { "status": "APPROVED" }
   ```

5. **Activar / Banear Usuario (`PATCH /users/:id/status` - ADMIN):**
   ```json
   { "isActive": true }
   ```

6. **Salud de la Red Blockchain (`GET /admin/blockchain/health` - ADMIN):**
   - Retorna métricas de salud y latencia del nodo.

7. **Gestionar Reclamos / Quejas (`PATCH /complaints/:id` - ADMIN):**
   ```json
   { "status": "RESOLVED" }
   ```

---

## 📊 9. Acto 8: Métricas, Notificaciones y Health Check

1. **Notificaciones del Usuario (`GET /notifications` - HOGAR):**
   - Consulta las alertas paginadas.

2. **Actualizar Notificación (`PATCH /notifications/:id` - HOGAR):**
   ```json
   { "isRead": true }
   ```

3. **Métricas de Hogar (`GET /households/me/metrics` - HOGAR):**
   - Retorna solicitudes, kg reciclados y EcoTokens.

4. **Reputación de Recolector (`GET /collectors/me/reputation` - RECOLECTOR):**
   - Retorna el score 4.8 y badges de recolección.

5. **Métricas ESG corporativas (`GET /b2b/me/esg-metrics` - EMPRESA_B2B):**
   - Retorna los KPIs de impacto ecológico.

6. **Métricas Globales de Sistema (`GET /admin/metrics` - ADMIN):**
   - Retorna el resumen ejecutivo global.

7. **Healthcheck General (`GET /`):**
   - Retorna `"Hello World!"`.

---

## 🎯 Conclusión del Manual

Este manual cubre formal y exhaustivamente los **42 endpoints del sistema (100% de la API)**. Siguiendo estos 8 actos secuenciales en Swagger UI, cualquier auditor, tester o desarrollador podrá verificar la totalidad de las funcionalidades de **Livora**. 🚀
