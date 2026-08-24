# 📱 Guía de migración Mobile — Livora sobre Stellar/Soroban

> Documento para el equipo mobile. Resume **qué cambió** en el backend (Arbitrum → **Stellar/Soroban**) y **qué implementar** en la app. Verificado contra el código real de la rama `Stellar-migration` y las correcciones ya desplegadas en el entorno Stellar.

---

## 1. Entorno / Base URL

| Entorno | Base URL | Notas |
|---|---|---|
| **Stellar (usar este)** | `https://stellar.52.200.2.107.sslip.io` | API de la rama `Stellar-migration`. Swagger en `/api/docs`. |
| Arbitrum (anterior, sigue vivo) | `https://52.200.2.107.sslip.io` | No apuntar aquí. |

- Todo HTTPS. Header de auth: `Authorization: Bearer <accessToken>`.
- **Rate limiting:** 100 req/60 s por IP global; **auth 5 req/60 s** por endpoint (register/login/verify/resend), refresh 10/60 s. Excederlo → **HTTP 429**; manejar con backoff.
- **Health check:** `GET /health`.

### Formato de error (¡importante, tiene 3 campos!)
- Errores normales:
  ```json
  { "error": { "code": "UNAUTHORIZED", "message": "Credenciales inválidas" } }
  ```
- **Errores de validación** (400): el `message` es genérico y el motivo real está en **`details`** (array):
  ```json
  { "error": {
      "code": "BAD_REQUEST",
      "message": "Error de validación en los parámetros de entrada",
      "details": ["La contraseña debe contener al menos una mayúscula, ..."]
  } }
  ```
  → La app debe leer `error.details` para mostrar el motivo real.
- ⚠️ El `ValidationPipe` global usa `forbidNonWhitelisted: true`: **cualquier campo de más en el body devuelve 400**. Enviar solo los campos documentados.

---

## 2. ⚠️ Autenticación (cambios que ROMPEN)

### 2.1 Registro en DOS pasos con OTP por correo

**Paso 1 — Solicitar registro** → responde **HTTP 201** (no 200):
```
POST /auth/register
{ "email": "hogar1@livora.com", "password": "Password123!", "role": "HOGAR" }
```
```json
{ "message": "Código de verificación enviado al correo electrónico", "email": "hogar1@livora.com" }
```
- `role` ∈ `HOGAR` · `RECOLECTOR` · `CENTRO_ACOPIO` (también `ALMACEN`, `TIENDA`, `EMPRESA_B2B`, `ADMIN`).
- ⚠️ **Política de contraseña (esto es lo que más frustra en el alta):** mínimo 8 caracteres **y además** al menos **una mayúscula, una minúscula, un número y un símbolo**. Ej. válido: `Password123!`. Si falla, el motivo llega en `error.details`.

**Paso 2 — Verificar OTP** → **HTTP 200**, aquí sí viene el token **y el objeto `user`**:
```
POST /auth/verify-email
{ "email": "hogar1@livora.com", "code": "123456" }
```
```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "v1.Mr8...",
  "expiresIn": 3600,
  "tokenType": "bearer",
  "user": { "id": "uuid", "email": "hogar1@livora.com", "role": "HOGAR", "walletAddress": "G..." }
}
```

**Reenviar código** (cooldown de 60 s en el server; si no ha pasado → 400):
```
POST /auth/resend-otp
{ "email": "hogar1@livora.com" }
```

**Implica en la app:** pantalla de código de 6 dígitos, botón "reenviar" (manejar el 400 de cooldown), y guardar `accessToken` + `refreshToken` + caducidad.

> ✅ Correo (Brevo) operativo — el OTP llega sin problemas.

### 2.2 Login → **HTTP 200**, incluye `user`
```
POST /auth/login
{ "email": "hogar1@livora.com", "password": "Password123!" }
```
→ `{ accessToken, refreshToken, expiresIn, tokenType, user: { id, email, role, walletAddress } }`

De aquí sale el **rol** y la **wallet** del usuario (guárdalos en el login/verify).

### 2.3 Renovar sesión — `POST /auth/refresh` ✅ NUEVO (resuelve el bloqueante #1)

Ya no muere la sesión a los 60 min ni hace falta la anon key de Supabase en la app:
```
POST /auth/refresh
{ "refreshToken": "v1.Mr8..." }
```
→ `{ accessToken, refreshToken, expiresIn, tokenType, user: {...} }` (mismos campos que login).
Llámalo cuando el `accessToken` esté por vencer (usa `expiresIn`) o ante un 401, y reintenta la petición.

### 2.4 Perfil actual — `GET /users/me` ✅ NUEVO
```
GET /users/me      (Bearer)
```
→ `{ id, email, role, walletAddress, createdAt }`. Útil para rehidratar el perfil tras un refresh o al abrir la app.

### 2.5 Wallets ahora son **Stellar** (`G…`), no EVM (`0x…`)
- Dirección Stellar `G…` (56 chars, base32). El backend la crea sola al registrarse (custodial).
- Quitar validaciones/regex `^0x` de la app. Explorador: `https://stellar.expert/explorer/testnet/account/<G...>`.
- Token de recompensa = **EcoToken (ECO)**. On-chain usa 7 decimales, pero **el API ya devuelve el balance formateado** (§4): la app no convierte decimales.

---

## 3. Push notifications (FCM) — ⛔ bloqueado por archivos de Firebase

El backend envía push por FCM; la app registra su token:
```
PATCH /users/fcm-token      (Bearer)
{ "fcmToken": "<token FCM>" }
```
**Falta para poder implementarlo** (proyecto Firebase `livora-app-fd5a3`):
- `google-services.json` (Android) y `GoogleService-Info.plist` (iOS).
- Confirmar que la app Android en Firebase está registrada con el package `com.livoralabs.livora_labs` y el **bundle id de iOS**. Si no coinciden, hay que registrar la app de nuevo.

> El backend solo consume el token FCM; no valida el package. El match package/bundle es entre Firebase y la app — se resuelve en la consola de Firebase, no en el backend.

---

## 4. Wallet, balance y modo Relayer

```
GET  /wallets/me/balance          → { "balance": "12.34" }   (string, 2 decimales, ECO)
GET  /wallets/transactions/history
POST /wallets/transactions        (relayer subsidia el gas)
```

**Modo Relayer en Stellar = REAL** (las envs `WORKER_SECRET_KEY` y `ECOTOKEN_CONTRACT_ID` están configuradas). Comportamiento que verá QA:
- **Balance:** intenta on-chain (Soroban) primero; si la llamada RPC falla, cae a un cálculo desde la BD (mock). En ambos casos devuelve `{ balance: "N.NN" }`.
- **Transacciones:** intenta el envío on-chain real y devuelve un **hash Stellar de 64 hex**. Si el envío on-chain falla (p.ej. saldo/`transfer` revierte), cae a un id sintético `relayer<hex>…` y **no** toca la cadena.
- Tu heurística en la app (enlazar a Stellar Expert solo si el id es 64-hex) es **correcta**: los `relayer…` no son hashes reales.

---

## 5. WebSockets (tiempo real) — ✅ funcionando (verificado end-to-end)

Sí hay gateway Socket.IO con adaptador Redis, **estable en Stellar**. Autenticación con el **mismo `accessToken`**, validado remotamente contra Supabase (soporta los tokens ES256 actuales). Verificado en vivo: conexión con token real → evento `connected {userId, role}` y unión a la sala del rol.

**Conexión:**
```js
io('https://stellar.52.200.2.107.sslip.io', { auth: { token: accessToken } })
// alternativa: ?token=<accessToken> en la query
```
El JWT se valida contra `SUPABASE_JWT_SECRET`. Sin token → el server desconecta el socket.

**Entrada a salas = automática por el servidor. NO tienes que emitir `join`.** Al conectar, el server te mete en tus salas según tu rol. Cuando termina, emite un evento **`connected` `{ userId, role }`** que puedes escuchar como confirmación.

| Rol | Salas a las que entra automáticamente | Eventos que recibe |
|---|---|---|
| Todos | `user:<userId>` | eventos directos al usuario |
| RECOLECTOR | `collectors:active` | `collection:created` |
| CENTRO_ACOPIO / ALMACEN | `center:<userId>` | `batch:completed` |
| TIENDA | `store:<userId>` | `redemption:completed`, `settlement:paid` |

> 🔧 **Corregido (2 bugs):** (1) el gateway validaba el JWT con `jwt.verify` HS256, pero Supabase emite **ES256** → la verificación fallaba siempre y **cortaba toda conexión** (con o sin token). Ahora usa `supabase.auth.getUser(token)` como el guard HTTP. (2) el rol se leía del JWT (`role: "authenticated"`); ahora se resuelve desde PostgreSQL. **Ya funciona** — mete `socket_io_client`, escucha `connected` + los eventos de sala; no más polling.

---

## 6. Subida de archivos — ✅ IMPLEMENTADO (`POST /uploads`)

Sube a Supabase Storage (bucket público `livora-uploads`) con la service key del backend y devuelve la URL pública. La app **solo hace multipart, sin credenciales de Storage**. Verificado end-to-end (201 + URL que sirve el archivo).

**Contrato:**
```
POST /uploads          (Bearer, multipart/form-data)
```
| Campo (form-data) | Valor |
|---|---|
| `file` | el binario (requerido) |
| `purpose` | `collection` \| `kyc` \| `receipt` (opcional, default `collection`) |

- **Tamaño máx:** 10 MB.
- **Tipos:** `image/jpeg`, `image/png`. Además `application/pdf` **solo** cuando `purpose=kyc`.
- **Respuesta 201:**
  ```json
  { "url": "https://...supabase.co/storage/v1/object/public/livora-uploads/collection/<uuid>.png",
    "purpose": "collection", "mimeType": "image/png", "size": 12345 }
  ```
- Errores como el resto de la API (400 con `error.message` claro si el tipo/tamaño no cumple).

Flujo en la app: subir el archivo → tomar `url` → mandarla como `photoUrl` / `documentUrl` / `receiptUrl` en el POST correspondiente.

---

## 7. Referencia de endpoints por módulo

> Protegidas requieren `Authorization: Bearer <accessToken>`.

**Auth**
| Método | Ruta | Uso |
|---|---|---|
| POST | `/auth/register` | Paso 1: solicita OTP (201) |
| POST | `/auth/verify-email` | Paso 2: valida OTP → token + user |
| POST | `/auth/resend-otp` | Reenvía OTP |
| POST | `/auth/login` | Login → token + user |
| POST | `/auth/refresh` | 🆕 Renueva sesión con refreshToken |

**Usuarios / Wallet / Notificaciones**
| Método | Ruta | Uso |
|---|---|---|
| GET | `/users/me` | 🆕 Perfil (rol, wallet) |
| POST | `/uploads` | 🆕 Subir archivo → `{ url }` (§6) |
| PATCH | `/users/fcm-token` | Registrar token FCM |
| DELETE | `/users/me` | Eliminar cuenta (GDPR) |
| GET | `/wallets/me/balance` | Balance ECO |
| GET | `/wallets/transactions/history` | Historial |
| POST | `/wallets/transactions` | Transferencia vía relayer |
| GET / PATCH | `/notifications` · `/notifications/:id` | Ver / marcar leída |

**HOGAR — Recolecciones**
| Método | Ruta |
|---|---|
| POST/GET | `/collection-requests` · `/collection-requests/:id` |
| PATCH | `/collection-requests/:id` (actualizar/cancelar) |
| POST | `/collection-requests/:id/verify` (PIN presencial) |
| GET | `/households/me/metrics` |

**RECOLECTOR — Lotes**
| Método | Ruta |
|---|---|
| GET | `/batches` · `/batches/open` |
| PATCH | `/batches/:id` (asignar centro → IN_TRANSIT) |
| POST | `/batches/:id/receive` (pesaje → on-chain, 202) |
| POST | `/collectors/kyc-applications` |
| GET | `/collectors/me/reputation` |

**CENTRO DE ACOPIO**
| Método | Ruta |
|---|---|
| GET | `/centers/me/reception-pin` · `/centers` |
| POST | `/centers/me/reception-pin/refresh` |
| GET / POST | `/inventory` · `/inventory/movements` |

**Tiendas (canje QR)**
| Método | Ruta |
|---|---|
| POST/GET | `/stores/profile` |
| POST | `/stores/redemptions/qr` → body `{ "tokenAmount": 15.5 }` (¡un solo campo!) |
| GET | `/stores/redemptions/:qrCodeRef` |
| POST | `/stores/redemptions/confirm/:qrCodeRef` |
| POST/PATCH | `/stores/settlements` · `/stores/settlements/:id/pay` |
| GET | `/stores/redemptions` · `/stores/settlements/history` |

**B2B / Ventas / Métricas**
| Método | Ruta |
|---|---|
| POST/GET/PATCH | `/b2b-transfers` · `/b2b-transfers/incoming` · `/b2b-transfers/:id/receive` · `/b2b-transfers/companies` |
| POST | `/b2b/applications` |
| POST/GET | `/sales` · `/certificates` |
| GET | `/b2b/me/esg-metrics` |

---

## 8. Estado de entornos (QA)

- **La BD de Stellar es NUEVA y aislada** (no es la de Arbitrum).
- ✅ **Cuentas de QA sembradas** (login directo, sin OTP):
  | Email | Password | Rol |
  |---|---|---|
  | `recolector1@livora.com` | `Password123!` | RECOLECTOR |
  | `centro1@livora.com` | `Password123!` | CENTRO_ACOPIO |

  (Más el HOGAR que ya tiene el dev.) Con esto se prueba el flujo completo: solicitud → aceptación → lote → recepción/pesaje → recompensa.
- **Relayer real activo** (ver §4). El balance saldrá `0.00` hasta que se procese un lote con recompensa.
- Correo/OTP operativo (Brevo con IP autorizada).

---

## 9. Correcciones aplicadas en el backend (ya desplegadas y verificadas en Stellar)

- 🆕 `POST /auth/refresh`, `GET /users/me`, `POST /uploads`.
- 🔧 **WebSockets:** auth ES256 (usa `getUser`, antes cortaba todo) + rol desde BD. Verificado con token real.
- 🔧 **Fechas:** el interceptor IPFS reventaba las `Date` a `{}` en toda la API; ahora se serializan como ISO (verificado en `/users/me`).
- 🔧 **OTP endurecido:** límite de 5 intentos por registro; el blob de registro vive 30 min (el OTP 10 min) para que "reenviar" pueda rescatar tras expirar.
- 🔧 `POST /stores/redemptions/qr`: un solo campo `tokenAmount` (quitada la trampa del 400).
- 🔧 Swagger: título de la API y summary de `/wallets/me/balance` ahora dicen "Stellar/Soroban".

**Sigue pendiente (fuera del backend):** archivos de Firebase para FCM (§3).

## 10. Checklist mobile

- [ ] Base URL → `https://stellar.52.200.2.107.sslip.io`.
- [ ] Registro en 2 pasos + política de contraseña completa (may/min/número/símbolo).
- [ ] Guardar `accessToken` + `refreshToken`; renovar con `POST /auth/refresh` (usar `expiresIn` o ante 401).
- [ ] Leer `user` del login/verify (rol + wallet); opcional `GET /users/me`.
- [ ] Parsear errores: motivo real en `error.details`; no enviar campos de más (400).
- [ ] Wallet formato Stellar `G…`; enlaces a Stellar Expert testnet.
- [ ] WebSockets: `socket_io_client` con `auth.token`, escuchar `connected` + eventos de sala (sin `join`). ✅ listo en backend.
- [ ] Subir archivos con `POST /uploads` y usar la `url` en `photoUrl`/`documentUrl`/`receiptUrl`. ✅ listo en backend.
- [ ] Manejar HTTP 429 con backoff.
- [ ] QR: enviar solo `{ tokenAmount }`.
- [x] ✅ Cuentas de QA sembradas (recolector1 / centro1).
- [ ] ⛔ FCM: esperar archivos de Firebase + confirmación de package/bundle id (único pendiente de backend/infra).

---

_Verificado contra el código de la rama `Stellar-migration`. Contratos exactos: Swagger en `https://stellar.52.200.2.107.sslip.io/api/docs`._
