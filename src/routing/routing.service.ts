import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { RoutingProfile, RoutingRequestDto } from './dto/routing-request.dto';
import { RoutingResponseDto } from './dto/routing-response.dto';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly inflightRequests = new Map<string, Promise<RoutingResponseDto>>();
  private readonly osrmBaseUrl: string;
  private readonly nominatimUrl: string;
  private readonly tomtomApiKey?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.osrmBaseUrl =
      this.configService.get<string>('OSRM_ROUTER_URL') ||
      'https://routing.openstreetmap.de/routed-car';
    this.nominatimUrl =
      this.configService.get<string>('NOMINATIM_URL') ||
      'https://nominatim.openstreetmap.org';
    this.tomtomApiKey = this.configService.get<string>('TOMTOM_API_KEY');
  }

  /**
   * Búsqueda predictiva de direcciones (Forward Geocoding) con caché Redis de 24h
   */
  async searchAddress(query: string): Promise<any[]> {
    const clean = query.trim().toLowerCase();
    if (clean.length < 3) return [];

    const cacheKey = `geocode:search:${encodeURIComponent(clean)}`;
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Ignora errores transitorios de lectura de caché
    }

    const url = `${this.nominatimUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(clean)}&format=json&limit=5&countrycodes=pe&addressdetails=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LivoraBackend/1.0 (contact@livora.pe)',
          Accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const list = (await res.json()) as any[];
      const results = list
        .map((item) => ({
          address: item.display_name ?? '',
          latitude: parseFloat(item.lat ?? '0'),
          longitude: parseFloat(item.lon ?? '0'),
        }))
        .filter((e) => e.latitude !== 0 && e.longitude !== 0);

      // Guardar en Redis 24 horas (86400s)
      await this.redisService.set(cacheKey, JSON.stringify(results), 86400).catch(() => {});
      return results;
    } catch (err: any) {
      this.logger.warn(`Error en búsqueda geocoding upstream: ${err.message}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Geocodificación inversa (LatLng -> Dirección legible) con caché Redis de 24h
   */
  async reverseGeocode(lat: number, lng: number): Promise<{ address: string } | null> {
    const cacheKey = `geocode:rev:${lat.toFixed(4)},${lng.toFixed(4)}`;
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // Ignora errores transitorios de lectura de caché
    }

    const url = `${this.nominatimUrl.replace(/\/$/, '')}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LivoraBackend/1.0 (contact@livora.pe)',
          Accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const data = (await res.json()) as any;

      let formattedAddress = data.display_name ?? '';
      const address = data.address;
      if (address) {
        const road = address.road ?? address.pedestrian ?? address.street ?? address.path;
        const houseNumber = address.house_number;
        const suburb = address.suburb ?? address.neighbourhood ?? address.district;
        const city = address.city ?? address.town ?? address.village;

        const parts: string[] = [];
        if (road) {
          parts.push(houseNumber ? `${road} ${houseNumber}` : road);
        }
        if (suburb) parts.push(suburb);
        else if (city) parts.push(city);

        if (parts.length > 0) {
          formattedAddress = parts.join(', ');
        }
      }

      const result = { address: formattedAddress };
      await this.redisService.set(cacheKey, JSON.stringify(result), 86400).catch(() => {});
      return result;
    } catch (err: any) {
      this.logger.warn(`Error en geocodificación inversa upstream: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Calcula la distancia geodésica de Haversine entre dos puntos WGS-84 en kilómetros.
   */
  haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Genera la geometría y estimación de contingencia ante caídas o timeouts de OSRM.
   * Utiliza la fórmula de Haversine * factor de tortuosidad urbana de 1.3 a 20 km/h.
   */
  getHaversineFallback(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    profile: RoutingProfile = RoutingProfile.DRIVING,
  ): RoutingResponseDto {
    const straightKm = this.haversineKm(originLat, originLng, destLat, destLng);
    const tortuosityFactor = profile === RoutingProfile.WALKING ? 1.2 : 1.3;
    const distanceMeters = Math.round(straightKm * tortuosityFactor * 1000);

    // Velocidades representativas según medio de transporte:
    // DRIVING (Moto carga / Camioneta): ~22 km/h
    // CYCLING (Bicicleta / Triciclo a pedal): ~13 km/h
    // WALKING (A pie con carrito manual): ~4.2 km/h
    let speedKmh = 22;
    if (profile === RoutingProfile.CYCLING) speedKmh = 13;
    if (profile === RoutingProfile.WALKING) speedKmh = 4.2;

    const speedMps = speedKmh / 3.6;
    const durationSeconds = Math.max(30, Math.round(distanceMeters / speedMps));
    const etaMinutes = Math.max(1, Math.round(durationSeconds / 60));

    // Generar línea recta con puntos intermedios interpolados para trazado en mapa
    const intermediatePoints = 5;
    const coordinates: [number, number][] = [];
    for (let i = 0; i <= intermediatePoints; i++) {
      const frac = i / intermediatePoints;
      const lat = originLat + (destLat - originLat) * frac;
      const lng = originLng + (destLng - originLng) * frac;
      coordinates.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
    }

    return {
      geometry: {
        type: 'LineString',
        coordinates,
      },
      distanceMeters,
      durationSeconds,
      etaMinutes,
      isFallback: true,
    };
  }

  /**
   * Traza la ruta A->B consultando la caché de Redis, deduplicando peticiones en vuelo
   * y consumiendo el proxy OSRM con failover a Haversine.
   */
  async calculateRoute(dto: RoutingRequestDto): Promise<RoutingResponseDto> {
    const { originLat, originLng, destLat, destLng, profile = RoutingProfile.DRIVING } = dto;
    const cacheKey = `route:${profile}:${originLat.toFixed(4)},${originLng.toFixed(4)}:${destLat.toFixed(4)},${destLng.toFixed(4)}`;

    // 1. Verificar caché Redis (TTL 10s)
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: any) {
      this.logger.warn(`Error leyendo caché de ruta en Redis: ${err.message}`);
    }

    // 2. Deduplicación de peticiones idénticas en vuelo (In-flight coalescing)
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const task = this.fetchFromUpstreamOrFallback(dto, cacheKey);
    this.inflightRequests.set(cacheKey, task);

    try {
      return await task;
    } finally {
      this.inflightRequests.delete(cacheKey);
    }
  }

  private async fetchFromUpstreamOrFallback(
    dto: RoutingRequestDto,
    cacheKey: string,
  ): Promise<RoutingResponseDto> {
    const { originLat, originLng, destLat, destLng, profile = RoutingProfile.DRIVING } = dto;
    const osrmProfile = profile === RoutingProfile.DRIVING ? 'driving' : profile;
    const coords = `${originLng},${originLat};${destLng},${destLat}`;
    const url = `${this.osrmBaseUrl.replace(/\/$/, '')}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LivoraBackend/1.0 (RoutingProxy)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`OSRM HTTP error: ${response.status}`);
      }

      const json = await response.json();
      const route = json?.routes?.[0];

      if (json?.code !== 'Ok' || !route?.geometry?.coordinates?.length) {
        throw new Error('OSRM no retornó una ruta válida');
      }

      let durationSeconds = Math.round(route.duration);
      const distanceMeters = Math.round(route.distance);
      let trafficFactor: number | undefined;

      // Ajustar duración y ETA según el medio de transporte
      if (profile === RoutingProfile.WALKING) {
        durationSeconds = Math.max(30, Math.round(distanceMeters / (4.2 / 3.6)));
      } else if (profile === RoutingProfile.CYCLING) {
        durationSeconds = Math.max(30, Math.round(distanceMeters / (13.0 / 3.6)));
      } else if (this.tomtomApiKey) {
        // Integración opcional de capa de tráfico TomTom si está configurada (solo DRIVING)
        trafficFactor = await this.fetchTomTomTrafficFactor(originLat, originLng);
        if (trafficFactor && trafficFactor > 1.0) {
          durationSeconds = Math.round(durationSeconds * trafficFactor);
        }
      }

      const etaMinutes = Math.max(1, Math.round(durationSeconds / 60));

      const result: RoutingResponseDto = {
        geometry: {
          type: 'LineString',
          coordinates: route.geometry.coordinates,
        },
        distanceMeters,
        durationSeconds,
        etaMinutes,
        isFallback: false,
        trafficFactor,
      };

      // Guardar en caché Redis por 10 segundos
      await this.redisService.set(cacheKey, JSON.stringify(result), 10).catch(() => {});
      return result;
    } catch (err: any) {
      this.logger.warn(
        `Falla en OSRM upstream (${err.message}). Conmutando a fallback geodésico Haversine.`,
      );
      const fallbackResult = this.getHaversineFallback(originLat, originLng, destLat, destLng, profile);
      // Guardar fallback en caché breve (5s) para aliviar congestión
      await this.redisService.set(cacheKey, JSON.stringify(fallbackResult), 5).catch(() => {});
      return fallbackResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Consulta el flujo de tráfico de TomTom para obtener un factor de congestión vial.
   */
  private async fetchTomTomTrafficFactor(lat: number, lng: number): Promise<number | undefined> {
    if (!this.tomtomApiKey) return undefined;
    try {
      const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json?point=${lat},${lng}&key=${this.tomtomApiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return undefined;
      const data = await res.json();
      const currentSpeed = data?.flowSegmentData?.currentSpeed;
      const freeFlowSpeed = data?.flowSegmentData?.freeFlowSpeed;

      if (currentSpeed && freeFlowSpeed && currentSpeed > 0) {
        const factor = Number((freeFlowSpeed / currentSpeed).toFixed(2));
        return Math.min(2.5, Math.max(1.0, factor));
      }
    } catch {
      // Ignorar fallas silenciosas de tráfico opcional
    }
    return undefined;
  }

  /**
   * Optimización Multi-Parada (VRP - Traveling Salesperson Problem)
   * Ordena matemáticamente las paradas del recolector para minimizar distancia y tiempo.
   */
  async optimizeTrip(dto: any): Promise<any> {
    const { collectorLat, collectorLng, waypoints, profile = RoutingProfile.DRIVING } = dto;
    if (!waypoints || waypoints.length === 0) {
      return {
        orderedWaypoints: [],
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        etaMinutes: 0,
        geometry: { type: 'LineString', coordinates: [] },
        isFallback: false,
      };
    }

    if (waypoints.length === 1) {
      const single = waypoints[0];
      const route = await this.calculateRoute({
        originLat: collectorLat,
        originLng: collectorLng,
        destLat: single.lat,
        destLng: single.lng,
        profile,
      });
      return {
        orderedWaypoints: [{ ...single, originalIndex: 0, optimizedOrder: 1 }],
        totalDistanceMeters: route.distanceMeters,
        totalDurationSeconds: route.durationSeconds,
        etaMinutes: route.etaMinutes,
        geometry: route.geometry,
        isFallback: route.isFallback,
      };
    }

    const osrmProfile = profile === RoutingProfile.DRIVING ? 'driving' : profile;
    const coords = [`${collectorLng},${collectorLat}`, ...waypoints.map((w: any) => `${w.lng},${w.lat}`)].join(';');
    const url = `${this.osrmBaseUrl.replace(/\/$/, '')}/trip/v1/${osrmProfile}/${coords}?source=first&roundtrip=false&overview=full&geometries=geojson`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LivoraBackend/1.0 (TripOptimizer)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) throw new Error(`OSRM Trip HTTP ${response.status}`);
      const json = await response.json();
      const trip = json?.trips?.[0];

      if (json?.code !== 'Ok' || !trip?.geometry?.coordinates?.length) {
        throw new Error('OSRM Trip no retornó una solución válida');
      }

      // OSRM retorna los waypoints con 'waypoint_index' que indica el orden en el viaje
      // Filtrar el índice 0 que corresponde a la posición inicial del recolector
      const osrmWaypoints: any[] = json.waypoints || [];
      const orderedWaypoints = osrmWaypoints
        .map((wp, idx) => ({ ...wp, originalInputIdx: idx }))
        .filter((wp) => wp.originalInputIdx > 0)
        .sort((a, b) => a.waypoint_index - b.waypoint_index)
        .map((wp, order) => {
          const original = waypoints[wp.originalInputIdx - 1];
          return {
            ...original,
            originalIndex: wp.originalInputIdx - 1,
            optimizedOrder: order + 1,
          };
        });

      return {
        orderedWaypoints,
        totalDistanceMeters: Math.round(trip.distance),
        totalDurationSeconds: Math.round(trip.duration),
        etaMinutes: Math.max(1, Math.round(trip.duration / 60)),
        geometry: {
          type: 'LineString',
          coordinates: trip.geometry.coordinates,
        },
        isFallback: false,
      };
    } catch (err: any) {
      this.logger.warn(`OSRM Trip upstream falló (${err.message}). Conmutando a Greedy Nearest-Neighbor.`);
      return this.greedyTripFallback(collectorLat, collectorLng, waypoints, profile);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Algoritmo de Contingencia Greedy Nearest Neighbor para optimización de ruta multi-parada
   */
  private greedyTripFallback(
    startLat: number,
    startLng: number,
    waypoints: any[],
    profile: RoutingProfile,
  ): any {
    const unvisited = [...waypoints];
    const ordered: any[] = [];
    let currentLat = startLat;
    let currentLng = startLng;
    let totalKm = 0;
    const allCoords: [number, number][] = [[startLng, startLat]];

    let stepOrder = 1;
    while (unvisited.length > 0) {
      let nearestIdx = 0;
      let minDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
        const d = this.haversineKm(currentLat, currentLng, unvisited[i].lat, unvisited[i].lng);
        if (d < minDistance) {
          minDistance = d;
          nearestIdx = i;
        }
      }

      const next = unvisited.splice(nearestIdx, 1)[0];
      totalKm += minDistance;
      ordered.push({
        ...next,
        originalIndex: waypoints.indexOf(next),
        optimizedOrder: stepOrder++,
      });

      // Puntos interpolados para polilínea visual
      for (let f = 1; f <= 3; f++) {
        const frac = f / 3;
        allCoords.push([
          Number((currentLng + (next.lng - currentLng) * frac).toFixed(6)),
          Number((currentLat + (next.lat - currentLat) * frac).toFixed(6)),
        ]);
      }

      currentLat = next.lat;
      currentLng = next.lng;
    }

    const tortuosity = 1.3;
    const distanceMeters = Math.round(totalKm * tortuosity * 1000);
    const speedMps = 22 / 3.6; // ~22 km/h en moto carga
    const durationSeconds = Math.max(60, Math.round(distanceMeters / speedMps));

    return {
      orderedWaypoints: ordered,
      totalDistanceMeters: distanceMeters,
      totalDurationSeconds: durationSeconds,
      etaMinutes: Math.max(1, Math.round(durationSeconds / 60)),
      geometry: {
        type: 'LineString',
        coordinates: allCoords,
      },
      isFallback: true,
    };
  }
}

