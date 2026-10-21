/**
 * GeoLocation Utility - PUCP Disoft Best Practices:
 * Eradica el antipatrón 'Cut & Paste' centralizando el cálculo de distancias
 * geodésicas (Haversine WGS-84) y validación de geocercas en una sola unidad cohesiva.
 */

export class GeoUtil {
  private static readonly EARTH_RADIUS_KM = 6371;

  /**
   * Calcula la distancia ortodrómica (gran círculo) en kilómetros entre dos coordenadas WGS-84
   * aplicando la fórmula de Haversine.
   */
  public static calculateHaversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (value: number): number => (value * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return this.EARTH_RADIUS_KM * c;
  }

  /**
   * Calcula la distancia en metros enteros redondeados entre dos coordenadas WGS-84.
   */
  public static calculateDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const distKm = this.calculateHaversineKm(lat1, lon1, lat2, lon2);
    return Math.round(distKm * 1000);
  }

  /**
   * Determina si dos coordenadas geográficas se encuentran dentro de un radio de tolerancia en metros.
   */
  public static isWithinGeofence(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
    radiusMeters: number,
  ): boolean {
    const distance = this.calculateDistanceMeters(lat1, lon1, lat2, lon2);
    return distance <= radiusMeters;
  }
}
