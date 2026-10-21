import { GeoUtil } from './geo.util';

describe('GeoUtil (PUCP Disoft - Anti-Cut&Paste Pattern)', () => {
  // Coordenadas conocidas: PUCP (San Miguel, Lima) y Parque Kennedy (Miraflores, Lima)
  const PUCP_LAT = -12.0694;
  const PUCP_LON = -77.0805;
  const KENNEDY_LAT = -12.1219;
  const KENNEDY_LON = -77.0297;

  it('debe calcular la distancia en kilómetros con la fórmula Haversine correctamente', () => {
    const distKm = GeoUtil.calculateHaversineKm(
      PUCP_LAT,
      PUCP_LON,
      KENNEDY_LAT,
      KENNEDY_LON,
    );

    // La distancia entre PUCP y Parque Kennedy es aprox 7.9 - 8.3 km
    expect(distKm).toBeGreaterThan(7.5);
    expect(distKm).toBeLessThan(8.5);
  });

  it('debe retornar 0 km si ambas coordenadas son idénticas', () => {
    const dist = GeoUtil.calculateHaversineKm(
      PUCP_LAT,
      PUCP_LON,
      PUCP_LAT,
      PUCP_LON,
    );
    expect(dist).toBeCloseTo(0, 5);
  });

  it('debe convertir correctamente a metros enteros redondeados', () => {
    const distMeters = GeoUtil.calculateDistanceMeters(
      PUCP_LAT,
      PUCP_LON,
      KENNEDY_LAT,
      KENNEDY_LON,
    );

    expect(Number.isInteger(distMeters)).toBe(true);
    expect(distMeters).toBeGreaterThan(7500);
    expect(distMeters).toBeLessThan(8500);
  });

  it('debe evaluar correctamente si un punto cae dentro de una geocerca', () => {
    // Un punto a 50 metros
    const nearLat = PUCP_LAT + 0.0003;
    const nearLon = PUCP_LON + 0.0003;

    expect(
      GeoUtil.isWithinGeofence(PUCP_LAT, PUCP_LON, nearLat, nearLon, 100),
    ).toBe(true);
    expect(
      GeoUtil.isWithinGeofence(PUCP_LAT, PUCP_LON, nearLat, nearLon, 10),
    ).toBe(false);
  });
});
