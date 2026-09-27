import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { RoutingProfile } from './routing-request.dto';

export class TripWaypointDto {
  @ApiProperty({ description: 'ID de la solicitud o parada', example: 'req-123' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Latitud de la parada', example: -12.0864 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ description: 'Longitud de la parada', example: -77.0351 })
  @IsLongitude()
  lng: number;

  @ApiPropertyOptional({ description: 'Etiqueta o dirección legible', example: 'Av. Larco 456' })
  @IsString()
  @IsOptional()
  label?: string;
}

export class OptimizeTripDto {
  @ApiProperty({ description: 'Latitud actual del recolector', example: -12.0850 })
  @IsLatitude()
  collectorLat: number;

  @ApiProperty({ description: 'Longitud actual del recolector', example: -77.0300 })
  @IsLongitude()
  collectorLng: number;

  @ApiProperty({
    description: 'Lista de paradas/solicitudes a ordenar de forma óptima',
    type: [TripWaypointDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TripWaypointDto)
  waypoints: TripWaypointDto[];

  @ApiPropertyOptional({
    description: 'Perfil de enrutamiento',
    enum: RoutingProfile,
    default: RoutingProfile.DRIVING,
  })
  @IsEnum(RoutingProfile)
  @IsOptional()
  profile?: RoutingProfile = RoutingProfile.DRIVING;
}
