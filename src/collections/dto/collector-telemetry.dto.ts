import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

export class CollectorTelemetryDto {
  @ApiProperty({ description: 'Latitud actual reportada por el sensor GPS', example: -12.047812 })
  @IsNumber()
  latitude: number;

  @ApiProperty({ description: 'Longitud actual reportada por el sensor GPS', example: -77.041289 })
  @IsNumber()
  longitude: number;

  @ApiPropertyOptional({ description: 'Rumbo u orientación magnética (0-360 grados)', example: 85.4 })
  @IsOptional()
  @IsNumber()
  heading?: number;

  @ApiPropertyOptional({ description: 'Velocidad en km/h reportada por el sensor', example: 22.5 })
  @IsOptional()
  @IsNumber()
  speed?: number;

  @ApiPropertyOptional({ description: 'Precisión del GPS en metros', example: 4.2 })
  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @ApiPropertyOptional({ description: 'Marca temporal epoch en ms', example: 1727218900000 })
  @IsOptional()
  @IsNumber()
  timestamp?: number;

  @ApiPropertyOptional({ description: 'Distancia restante en metros calculada por el motor de rutas', example: 450 })
  @IsOptional()
  @IsNumber()
  distanceRemainingMeters?: number;

  @ApiPropertyOptional({ description: 'Tiempo estimado de llegada en minutos', example: 3 })
  @IsOptional()
  @IsNumber()
  etaMinutes?: number;

  @ApiPropertyOptional({ description: 'Medio de transporte activo', example: 'MOTO_CARGA' })
  @IsOptional()
  transportType?: string;
}
