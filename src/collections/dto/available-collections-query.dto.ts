import { Type, Transform } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AvailableCollectionsQueryDto {
  @ApiProperty({
    description: 'Latitud GPS actual del recolector (-90 a 90)',
    example: -12.0864,
  })
  @Type(() => Number)
  @IsNumber({}, { message: 'lat debe ser un número decimal' })
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({
    description: 'Longitud GPS actual del recolector (-180 a 180)',
    example: -77.0351,
  })
  @Type(() => Number)
  @IsNumber({}, { message: 'lng debe ser un número decimal' })
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiPropertyOptional({
    description: 'Radio de búsqueda en kilómetros (1 a 20 km, por defecto 5)',
    default: 5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'radiusKm debe ser un número' })
  @Min(0.5, { message: 'radiusKm debe ser de al menos 0.5 km' })
  @Max(50, { message: 'radiusKm no puede exceder 50 km' })
  radiusKm?: number = 5;

  @ApiPropertyOptional({
    description: 'Filtrar solicitudes asignadas a un Centro de Acopio específico (UUID)',
  })
  @IsOptional()
  @IsUUID('4', { message: 'centerId debe ser un UUID válido' })
  centerId?: string;

  @ApiPropertyOptional({
    description:
      'Si es true, retorna únicamente solicitudes de aquellos Centros de Acopio para los que el recolector ya tiene un lote abierto en su camión',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true || value === 1 || value === '1') return true;
    if (value === 'false' || value === false || value === 0 || value === '0') return false;
    return undefined;
  })
  @IsBoolean()
  onlyActiveBatches?: boolean;
}
