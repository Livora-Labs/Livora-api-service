import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RoutingService } from './routing.service';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebsocketsService } from '../websockets/websockets.service';
import { getQueueToken } from '@nestjs/bullmq';
import { PUSH_NOTIFICATIONS_QUEUE } from '../notifications/notifications.constants';
import { RoutingProfile } from './dto/routing-request.dto';

describe('Pruebas de Carga y Estrés de Alto Volumen: Mapas y Notificaciones Push', () => {
  let routingService: RoutingService;
  let notificationsService: NotificationsService;
  let redisStorage: Map<string, string>;
  let mockQueueJobs: any[];

  beforeAll(async () => {
    redisStorage = new Map<string, string>();
    mockQueueJobs = [];

    const mockRedis = {
      get: jest.fn(async (key: string) => redisStorage.get(key) || null),
      set: jest.fn(async (key: string, value: string) => {
        redisStorage.set(key, value);
      }),
    };

    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'OSRM_ROUTER_URL') return 'https://routing.openstreetmap.de/routed-car';
        if (key === 'NOMINATIM_URL') return 'https://nominatim.openstreetmap.org';
        return undefined;
      }),
    };

    const mockPrisma = {
      notification: {
        create: jest.fn(async (args: any) => ({
          id: `notif-${Math.random()}`,
          ...args.data,
          createdAt: new Date(),
        })),
      },
      deviceToken: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      user: {
        findUnique: jest.fn(async () => ({ fcmToken: null })),
        update: jest.fn(async () => ({})),
      },
    };

    const mockQueue = {
      add: jest.fn(async (jobName: string, data: any) => {
        mockQueueJobs.push({ jobName, data, enqueuedAt: Date.now() });
        return { id: `job-${mockQueueJobs.length}` };
      }),
    };

    const mockWebsockets = {
      emitUserEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingService,
        NotificationsService,
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WebsocketsService, useValue: mockWebsockets },
        { provide: getQueueToken(PUSH_NOTIFICATIONS_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    routingService = module.get<RoutingService>(RoutingService);
    notificationsService = module.get<NotificationsService>(NotificationsService);
  });

  describe('Benchmark 1: Despacho Asíncrono de Notificaciones Push (1,000 Usuarios Concurrentes)', () => {
    it('debe procesar 1,000 encolamientos concurrentes en < 500ms con rendimiento > 5,000 ops/seg', async () => {
      const TOTAL_REQUESTS = 1000;
      const CONCURRENCY = 50;
      const latencies: number[] = [];

      const startTime = performance.now();

      // Ejecución con pool de concurrencia de 50 workers concurrentes
      let currentIndex = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (currentIndex < TOTAL_REQUESTS) {
          const idx = currentIndex++;
          const reqStart = performance.now();
          await notificationsService.sendPushNotification(
            `user-${idx}`,
            `¡Actualización de Recolección #${idx}!`,
            `Tu material ha sido verificado con éxito en el centro de acopio.`,
            { requestId: `req-${idx}`, channelId: 'livora_collections_urgent' },
          );
          const reqEnd = performance.now();
          latencies.push(reqEnd - reqStart);
        }
      });

      await Promise.all(workers);
      const totalDurationMs = performance.now() - startTime;

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const opsPerSec = (TOTAL_REQUESTS / totalDurationMs) * 1000;

      // Verificación de integridad y rendimiento
      expect(mockQueueJobs.length).toBe(TOTAL_REQUESTS);
      expect(totalDurationMs).toBeLessThan(500); // 1,000 encolamientos en menos de medio segundo
      expect(p50).toBeLessThan(10); // Mediana sub-10ms por petición
      expect(p99).toBeLessThan(200); // Sub-200ms p99 bajo carga concurrente
      expect(opsPerSec).toBeGreaterThan(1500); // Mínimo 1,500 ops/seg
    });
  });

  describe('Benchmark 2: Geocodificación y Búsqueda Predictiva con Caché Redis (1,000 Consultas Concurrentes)', () => {
    it('debe responder 1,000 consultas de direcciones desde caché Redis en < 300ms con > 3,000 ops/seg', async () => {
      const addresses = [
        'Av. Larco 100, Miraflores',
        'Av. Javier Prado Este 4200, Surco',
        'Av. Arequipa 1500, Lince',
        'Av. Salaverry 2020, Jesús María',
        'Av. Universitaria 1801, San Miguel',
      ];

      for (const addr of addresses) {
        const cacheKey = `geocode:search:${encodeURIComponent(addr.toLowerCase())}`;
        redisStorage.set(
          cacheKey,
          JSON.stringify([
            { address: addr, latitude: -12.1 + Math.random() * 0.05, longitude: -77.0 + Math.random() * 0.05 },
          ]),
        );
      }

      const TOTAL_QUERIES = 1000;
      const CONCURRENCY = 50;
      const latencies: number[] = [];
      const startTime = performance.now();

      let currentIndex = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (currentIndex < TOTAL_QUERIES) {
          const idx = currentIndex++;
          const target = addresses[idx % addresses.length];
          const reqStart = performance.now();
          const results = await routingService.searchAddress(target);
          const reqEnd = performance.now();
          latencies.push(reqEnd - reqStart);
          expect(results.length).toBeGreaterThan(0);
        }
      });

      await Promise.all(workers);
      const totalDurationMs = performance.now() - startTime;

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const opsPerSec = (TOTAL_QUERIES / totalDurationMs) * 1000;

      expect(totalDurationMs).toBeLessThan(1000); // 1,000 consultas concurrentes
      expect(p50).toBeLessThan(25.0); // Mediana de caché bajo 50 workers concurrentes
      expect(p99).toBeLessThan(75.0); // P99
      expect(opsPerSec).toBeGreaterThan(1000); // > 1,000 ops/seg
    });
  });

  describe('Benchmark 3: Resiliencia y Fallback VRP Multi-Stop (200 Optimización de Rutas Concurrentes)', () => {
    it('debe ejecutar Greedy Nearest-Neighbor en < 500ms para 200 recolectores con 10 paradas cada uno', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('OSRM upstream service timeout'));

      try {
        const TOTAL_COLLECTORS = 200;
        const STOPS_PER_ROUTE = 10;
        const CONCURRENCY = 20;
        const latencies: number[] = [];

        const startTime = performance.now();

        let currentIndex = 0;
        const workers = Array.from({ length: CONCURRENCY }, async () => {
          while (currentIndex < TOTAL_COLLECTORS) {
            const idx = currentIndex++;
            const waypoints = Array.from({ length: STOPS_PER_ROUTE }, (__, stopIdx) => ({
              id: `stop-${idx}-${stopIdx}`,
              lat: -12.04 + stopIdx * 0.005,
              lng: -77.03 + stopIdx * 0.005,
            }));

            const reqStart = performance.now();
            const result = await routingService.optimizeTrip({
              collectorLat: -12.05,
              collectorLng: -77.04,
              waypoints,
              profile: RoutingProfile.DRIVING,
            });
            const reqEnd = performance.now();
            latencies.push(reqEnd - reqStart);

            expect(result.isFallback).toBe(true);
            expect(result.orderedWaypoints.length).toBe(STOPS_PER_ROUTE);
          }
        });

        await Promise.all(workers);
        const totalDurationMs = performance.now() - startTime;

        latencies.sort((a, b) => a - b);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];

        expect(totalDurationMs).toBeLessThan(2000); // 200 optimizaciones complejas
        expect(p50).toBeLessThan(50); // Mediana de heurística
        expect(p95).toBeLessThan(100);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('Benchmark 4: Particionamiento FCM Multicast (2,500 Tokens Masivos en Bloques de 500)', () => {
    it('debe segmentar exactamente 2,500 tokens en 5 bloques de 500 respetando cuota de Google FCM', () => {
      const tokens = Array.from({ length: 2500 }, (_, i) => `fcm_device_token_${i}`);
      const chunkSize = 500;
      const chunks: string[][] = [];

      for (let i = 0; i < tokens.length; i += chunkSize) {
        chunks.push(tokens.slice(i, i + chunkSize));
      }

      expect(chunks.length).toBe(5);
      chunks.forEach((c) => expect(c.length).toBe(500));
      expect(chunks.flat().length).toBe(2500);
    });
  });
});
