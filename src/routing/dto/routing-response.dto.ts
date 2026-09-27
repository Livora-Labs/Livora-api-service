import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RouteGeometryDto {
  @ApiProperty({ example: 'LineString' })
  type: string;

  @ApiProperty({
    description: 'Arreglo de pares [lon, lat] en formato GeoJSON',
    example: [
      [-77.042793, -12.046374],
      [-77.032793, -12.056374],
    ],
  })
  coordinates: [number, number][];
}

export class RoutingResponseDto {
  @ApiProperty({ type: () => RouteGeometryDto })
  geometry: RouteGeometryDto;

  @ApiProperty({ description: 'Distancia total en metros', example: 1850.5 })
  distanceMeters: number;

  @ApiProperty({ description: 'Duración estimada en segundos', example: 360 })
  durationSeconds: number;

  @ApiProperty({ description: 'Tiempo estimado en minutos redondeado', example: 6 })
  etaMinutes: number;

  @ApiProperty({
    description: 'Indica si la respuesta proviene de la contingencia geodésica Haversine',
    example: false,
  })
  isFallback: boolean;

  @ApiPropertyOptional({
    description: 'Factor de tráfico ponderado aplicado (si TomTom estuvo activo)',
    example: 1.15,
  })
  trafficFactor?: number;
}
