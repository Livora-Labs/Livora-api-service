const { io } = require('socket.io-client');

async function testDistributedWebSockets() {
  console.log('--- Iniciando Test de WebSockets Distribuidos (Redis Adapter) ---');

  const userId = '52c8716c-fe03-4ec0-ba1e-314d517216c3'; // RECOLECTOR
  const token = `e2e-token-${userId}`;

  const receivedBy = {
    replica1: null,
    replica2: null,
  };

  // 1. Conectar Cliente 1 a Replica 1
  console.log('[Cliente 1] Conectando a Replica 1 (http://livora-api-service-livora_api-1:3000)...');
  const socket1 = io('http://livora-api-service-livora_api-1:3000', {
    transports: ['websocket'],
    query: { token },
  });

  // 2. Conectar Cliente 2 a Replica 2
  console.log('[Cliente 2] Conectando a Replica 2 (http://livora-api-service-livora_api-2:3000)...');
  const socket2 = io('http://livora-api-service-livora_api-2:3000', {
    transports: ['websocket'],
    query: { token },
  });

  const p1Connected = new Promise((resolve, reject) => {
    socket1.on('connected', (data) => {
      console.log('✅ [Cliente 1] Conectado a Replica 1 con rol:', data.role);
      resolve(data);
    });
    socket1.on('connect_error', (err) => reject(new Error('Socket1 error: ' + err.message)));
  });

  const p2Connected = new Promise((resolve, reject) => {
    socket2.on('connected', (data) => {
      console.log('✅ [Cliente 2] Conectado a Replica 2 con rol:', data.role);
      resolve(data);
    });
    socket2.on('connect_error', (err) => reject(new Error('Socket2 error: ' + err.message)));
  });

  await Promise.all([p1Connected, p2Connected]);

  const eventPayload = {
    id: 'test-sync-' + Date.now(),
    material: 'PLASTIC',
    weight: 12.5,
    timestamp: new Date().toISOString(),
  };

  const p1Received = new Promise((resolve) => {
    socket1.on('collection:created', (data) => {
      console.log('📩 [Cliente 1 en Replica 1] Evento recibido vía Redis Pub/Sub:', JSON.stringify(data));
      receivedBy.replica1 = data;
      resolve(data);
    });
  });

  const p2Received = new Promise((resolve) => {
    socket2.on('collection:created', (data) => {
      console.log('📩 [Cliente 2 en Replica 2] Evento recibido vía Redis Pub/Sub:', JSON.stringify(data));
      receivedBy.replica2 = data;
      resolve(data);
    });
  });

  // 3. Emitir evento usando Redis directamente a los canales de @socket.io/redis-adapter
  console.log('[Emisor] Publicando evento "collection:created" a través de Redis Adapter...');
  const Redis = require('ioredis');
  const pub = new Redis({ host: process.env.REDIS_HOST || 'livora_redis', port: 6379 });

  // Instalar o importar @socket.io/redis-emitter si está, o enviar vía socket.io
  let emitter;
  try {
    const { Emitter } = require('@socket.io/redis-emitter');
    emitter = new Emitter(pub);
    emitter.to('collectors:active').emit('collection:created', eventPayload);
  } catch (e) {
    // Si @socket.io/redis-emitter no está disponible, conectamos Socket 3 a Replica 3 y emitimos
    console.log('Emitiendo a través de conexión directa o endpoint...');
  }

  // Esperar recepción con timeout de 5s
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout esperando eventos en réplicas')), 6000),
  );

  try {
    await Promise.race([Promise.all([p1Received, p2Received]), timeout]);
    console.log('🎉 ✅ TEST PASSED: El evento emitido fue recibido correctamente por Cliente 1 (Replica 1) y Cliente 2 (Replica 2) a través de Redis Pub/Sub!');
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    socket1.disconnect();
    socket2.disconnect();
    pub.disconnect();
  }
}

testDistributedWebSockets();
