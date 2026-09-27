import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RoutingService } from './routing.service';
import { RedisService } from '../redis/redis.service';
import { RoutingProfile } from './dto/routing-request.dto';

describe('RoutingService', () => {
  let service: RoutingService;
  let redisService: jest.Mocked<Partial<RedisService>>;
  let configService: jest.Mocked<Partial<ConfigService>>;

  beforeEach(async () => {
    redisService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'OSRM_ROUTER_URL') return 'https://routing.openstreetmap.de/routed-car';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingService,
        { provide: RedisService, useValue: redisService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<RoutingService>(RoutingService);
  });

  describe('haversineKm', () => {
    it('debe calcular la distancia geodésica correcta entre dos coordenadas conocidas', () => {
      // Plaza de Armas de Lima (-12.046374, -77.042793) a Miraflores (-12.121667, -77.030556)
      // Distancia directa aprox ~8.4 km
      const distance = service.haversineKm(-12.046374, -77.042793, -12.121667, -77.030556);
      expect(distance).toBeGreaterThan(8.0);
      expect(distance).toBeLessThan(9.0);
    });

    it('debe devolver 0 para puntos idénticos', () => {
      const distance = service.haversineKm(-12.05, -77.03, -12.05, -77.03);
      expect(distance).toBe(0);
    });
  });

  describe('getHaversineFallback', () => {
    it('debe aplicar tortuosidad urbana de 1.3 y velocidad de 20 km/h', () => {
      const fallback = service.getHaversineFallback(-12.046374, -77.042793, -12.056374, -77.032793);
      expect(fallback.isFallback).toBe(true);
      expect(fallback.geometry.type).toBe('LineString');
      expect(fallback.geometry.coordinates.length).toBeGreaterThan(1);
      expect(fallback.distanceMeters).toBeGreaterThan(0);
      expect(fallback.durationSeconds).toBeGreaterThan(0);
      expect(fallback.etaMinutes).toBeGreaterThanOrEqual(1);
    });
  });

  describe('calculateRoute', () => {
    it('debe devolver la ruta desde la caché de Redis si existe', async () => {
      const cachedPayload = {
        geometry: { type: 'LineString', coordinates: [[-77.04, -12.04], [-77.03, -12.05]] },
        distanceMeters: 1500,
        durationSeconds: 300,
        etaMinutes: 5,
        isFallback: false,
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(cachedPayload));

      const result = await service.calculateRoute({
        originLat: -12.046374,
        originLng: -77.042793,
        destLat: -12.056374,
        destLng: -77.032793,
        profile: RoutingProfile.DRIVING,
      });

      expect(result).toEqual(cachedPayload);
      expect(redisService.get).toHaveBeenCalled();
    });

    it('debe conmutar automáticamente a Haversine si OSRM falla', async () => {
      // Mock global fetch para simular caída de red de OSRM
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network connection timeout'));

      try {
        const result = await service.calculateRoute({
          originLat: -12.046374,
          originLng: -77.042793,
          destLat: -12.056374,
          destLng: -77.032793,
        });

        expect(result.isFallback).toBe(true);
        expect(result.geometry.coordinates.length).toBeGreaterThan(0);
        expect(result.distanceMeters).toBeGreaterThan(0);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('searchAddress (Geocoding Forward)', () => {
    it('debe retornar lista vacía si la consulta tiene menos de 3 caracteres', async () => {
      const res = await service.searchAddress('li');
      expect(res).toEqual([]);
      expect(redisService.get).not.toHaveBeenCalled();
    });

    it('debe retornar resultados desde la caché de Redis si existen', async () => {
      const cached = [
        { address: 'Av. Larco 100, Miraflores, Lima', latitude: -12.12, longitude: -77.03 },
      ];
      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(cached));

      const res = await service.searchAddress('larco miraflores');
      expect(res).toEqual(cached);
      expect(redisService.get).toHaveBeenCalledWith('geocode:search:larco%20miraflores');
    });

    it('debe llamar a Nominatim y guardar en Redis si no está en caché', async () => {
      (redisService.get as jest.Mock).mockResolvedValueOnce(null);
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            display_name: 'Av. Arequipa 500, Lima',
            lat: '-12.0650',
            lon: '-77.0350',
          },
        ],
      } as any);

      try {
        const res = await service.searchAddress('arequipa 500');
        expect(res.length).toBe(1);
        expect(res[0].address).toBe('Av. Arequipa 500, Lima');
        expect(res[0].latitude).toBe(-12.065);
        expect(res[0].longitude).toBe(-77.035);
        expect(redisService.set).toHaveBeenCalledWith(
          'geocode:search:arequipa%20500',
          expect.any(String),
          86400,
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('reverseGeocode', () => {
    it('debe retornar la dirección formateada desde Redis si está en caché', async () => {
      const cached = { address: 'Calle Los Pinos 123, Miraflores' };
      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(cached));

      const res = await service.reverseGeocode(-12.1200, -77.0300);
      expect(res).toEqual(cached);
    });

    it('debe formatear dirección limpia a partir de datos estructurados de Nominatim', async () => {
      (redisService.get as jest.Mock).mockResolvedValueOnce(null);
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          display_name: 'Full Name Unused',
          address: {
            road: 'Av. Pardo',
            house_number: '200',
            suburb: 'Miraflores',
          },
        }),
      } as any);

      try {
        const res = await service.reverseGeocode(-12.1211, -77.0311);
        expect(res).toEqual({ address: 'Av. Pardo 200, Miraflores' });
        expect(redisService.set).toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('optimizeTrip (VRP Multi-Stop)', () => {
    it('debe manejar lista vacía de waypoints retornando orden vacío', async () => {
      const res = await service.optimizeTrip({
        collectorLat: -12.0463,
        collectorLng: -77.0427,
        waypoints: [],
      });
      expect(res.orderedWaypoints).toEqual([]);
      expect(res.totalDistanceMeters).toBe(0);
    });

    it('debe usar Greedy Nearest-Neighbor cuando OSRM Trip falla', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('OSRM trip server down'));

      try {
        // Recolector en (-12.00, -77.00)
        // Parada A lejana (-12.10, -77.00)
        // Parada B cercana (-12.01, -77.00)
        const waypoints = [
          { id: 'stop-far', lat: -12.10, lng: -77.00 },
          { id: 'stop-near', lat: -12.01, lng: -77.00 },
        ];

        const res = await service.optimizeTrip({
          collectorLat: -12.00,
          collectorLng: -77.00,
          waypoints,
          profile: RoutingProfile.DRIVING,
        });

        expect(res.isFallback).toBe(true);
        expect(res.orderedWaypoints.length).toBe(2);
        // El más cercano debe ser visitado primero
        expect(res.orderedWaypoints[0].id).toBe('stop-near');
        expect(res.orderedWaypoints[0].optimizedOrder).toBe(1);
        expect(res.orderedWaypoints[1].id).toBe('stop-far');
        expect(res.orderedWaypoints[1].optimizedOrder).toBe(2);
        expect(res.totalDistanceMeters).toBeGreaterThan(0);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
