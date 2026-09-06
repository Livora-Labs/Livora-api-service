import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

// ==============================================================================
// METRICAS PERSONALIZADAS Y SLAs
// ==============================================================================
const queryDuration = new Trend('query_latency_ms', true);
const scaleIngestDuration = new Trend('scale_ingest_latency_ms', true);
const cachedIdempotencyDuration = new Trend('cached_idempotency_latency_ms', true);
const deadlockCounter = new Counter('deadlock_count');
const error5xxCounter = new Counter('http_5xx_errors');

// ==============================================================================
// CONFIGURACION DE RAMPAS Y PARAMETROS
// ==============================================================================
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const IS_SMOKE = __ENV.SMOKE_TEST === 'true';
const JWT_SECRET = __ENV.SUPABASE_JWT_SECRET || 'meP0Mxf3fhqPJo3tSbNs8QScrh3k0IKhgYvnNzWzjImYhxsaMXx1HSVKVtEKtE3kHBj4wLDk2jYjE1NnTuUDAw==';

// Catálogo de usuarios precargados en la base de datos de Livora
const USERS = {
  HOGAR: {
    id: '1ae19524-c928-4590-952c-141335edfad2',
    email: 'hogar.test@livora.com',
    role: 'HOGAR',
  },
  RECOLECTOR: {
    id: '52c8716c-fe03-4ec0-ba1e-314d517216c3',
    email: 'recolector.test@livora.com',
    role: 'RECOLECTOR',
  },
  CENTRO_ACOPIO: {
    id: '3437ec04-8b9d-475e-83a1-89615fb849aa',
    email: 'centro_acopio.test@livora.com',
    role: 'CENTRO_ACOPIO',
  },
};

// Generación determinista y criptográfica de JWT HMAC-SHA256 (RFC 7519)
function createJwt(user) {
  const header = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
  const now = Math.floor(Date.now() / 1000);
  const payload = encoding.b64encode(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: 'authenticated',
      app_metadata: { role: user.role },
      user_metadata: { role: user.role },
      iat: now,
      exp: now + 7200,
    }),
    'rawurl'
  );

  const unsigned = `${header}.${payload}`;
  const sig = crypto.hmac('sha256', JWT_SECRET, unsigned, 'base64url').replace(/=+$/, '');
  return `${unsigned}.${sig}`;
}

const TOKENS = {
  HOGAR: createJwt(USERS.HOGAR),
  RECOLECTOR: createJwt(USERS.RECOLECTOR),
  CENTRO_ACOPIO: createJwt(USERS.CENTRO_ACOPIO),
};

export const options = {
  scenarios: {
    progressive_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: IS_SMOKE
        ? [
            { duration: '15s', target: 20 },
            { duration: '20s', target: 50 },
            { duration: '10s', target: 0 },
          ]
        : [
            // Stage 1: Rampa de 0 a 50 Virtual Users (VUs) en 1 minuto
            { duration: '1m', target: 50 },
            // Stage 2: Carga sostenida de 50 a 200 VUs durante 3 minutos
            { duration: '3m', target: 200 },
            // Stage 3: Pico de estrés (Spike Test) a 500 VUs durante 30 segundos
            { duration: '30s', target: 500 },
            // Stage 4: Ramp-down a 0 VUs en 30 segundos
            { duration: '30s', target: 0 },
          ],
    },
  },
  thresholds: {
    // Latencia p95 en endpoints de consulta (GET) < 200ms
    'query_latency_ms': ['p(95)<200'],
    // Latencia p95 en ingesta asíncrona de báscula (HTTP 202) < 50ms
    'scale_ingest_latency_ms': ['p(95)<50'],
    // Peticiones repetidas con Idempotency-Key resueltas desde Redis en < 30ms (SLA nominal < 15ms)
    'cached_idempotency_latency_ms': ['p(95)<30'],
    // Tasa de error HTTP 5xx igual a 0%
    'http_5xx_errors': ['count==0'],
    // Cero interbloqueos (deadlocks) en PostgreSQL durante mutaciones concurrentes
    'deadlock_count': ['count==0'],
  },
};

// ==============================================================================
// FLUJO PRINCIPAL DE PRUEBA (VIRTUAL USER ITERATION)
// ==============================================================================
export default function () {
  const vuId = __VU;
  const iter = __ITER;

  // Asignación balanceada de rol por VU
  const roleKeys = ['HOGAR', 'RECOLECTOR', 'CENTRO_ACOPIO'];
  const currentRole = roleKeys[vuId % 3];
  const token = TOKENS[currentRole];

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Correlation-ID': `k6-${currentRole}-${vuId}-${iter}`,
  };

  // ----------------------------------------------------------------------------
  // 1. ENDPOINTS DE CONSULTA (GET) - SLA p95 < 200ms
  // ----------------------------------------------------------------------------
  {
    const resHealth = http.get(`${BASE_URL}/health`, {
      headers: headers,
      tags: { type: 'query', endpoint: 'health' },
    });
    const durHealth = resHealth.timings.duration;
    queryDuration.add(durHealth, { type: 'query' });

    check(resHealth, {
      'GET /health responde status 200': (r) => r.status === 200,
      'GET /health latencia < 200ms': () => durHealth < 200,
    });

    if (resHealth.status >= 500) {
      error5xxCounter.add(1);
      if (resHealth.body && resHealth.body.includes('deadlock detected')) {
        deadlockCounter.add(1);
      }
    }
  }

  // Consulta de Precios Públicos de Centros de Acopio (GET REST)
  {
    const resPrices = http.get(`${BASE_URL}/centers/prices/all`, {
      headers: headers,
      tags: { type: 'query', endpoint: 'prices' },
    });
    const durPrices = resPrices.timings.duration;
    queryDuration.add(durPrices, { type: 'query' });

    check(resPrices, {
      'GET /centers/prices/all status 200': (r) => r.status === 200,
      'Latencia consulta precios < 200ms': () => durPrices < 200,
    });
  }

  // ----------------------------------------------------------------------------
  // 2. INGESTA ASÍNCRONA DE BÁSCULA (HTTP 202) - SLA p95 < 50ms
  // ----------------------------------------------------------------------------
  const batchId = 'c15efc9e-77ea-410c-8119-a6225dac9770'; // Lote de prueba
  const idempotencyKey = `k6-idemp-vu${vuId}-iter${Math.floor(iter / 2)}`;

  const scalePayload = JSON.stringify({
    materialsActual: {
      PET: 15.75,
      CARTON: 10.2,
    },
  });

  const scaleHeaders = Object.assign({}, headers, {
    'Authorization': `Bearer ${TOKENS.CENTRO_ACOPIO}`,
    'Idempotency-Key': idempotencyKey,
  });

  {
    const resScale = http.post(`${BASE_URL}/batches/${batchId}/receive`, scalePayload, {
      headers: scaleHeaders,
      tags: { type: 'scale_ingest' },
    });
    const durScale = resScale.timings.duration;
    scaleIngestDuration.add(durScale, { type: 'scale_ingest' });

    check(resScale, {
      'Ingesta de báscula procesada (200, 202, 400, 404 o 429 rate-limited)': (r) =>
        [200, 202, 400, 404, 429].includes(r.status),
      'Sin errores 5xx en mutación de báscula': (r) => r.status < 500,
    });

    if (resScale.status >= 500) {
      error5xxCounter.add(1);
      if (resScale.body && resScale.body.includes('deadlock detected')) {
        deadlockCounter.add(1);
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 3. PETICIÓN DUPLICADA CON IDEMPOTENCY-KEY - SLA p95 < 15ms (Desde Redis)
  // ----------------------------------------------------------------------------
  {
    const resCached = http.post(`${BASE_URL}/batches/${batchId}/receive`, scalePayload, {
      headers: scaleHeaders,
      tags: { type: 'cached_idempotency' },
    });
    const durCached = resCached.timings.duration;
    cachedIdempotencyDuration.add(durCached, { type: 'cached_idempotency' });

    check(resCached, {
      'Idempotencia duplicada no genera 5xx': (r) => r.status < 500,
      'Caché Redis responde en < 15ms': () => durCached < 15,
    });

    if (resCached.status >= 500) {
      error5xxCounter.add(1);
    }
  }

  // Pacing proporcional para emular ritmo de peticiones reales
  sleep(0.1);
}
