import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional } from 'class-validator';

export enum RoutingProfile {
  DRIVING = 'driving',
  WALKING = 'walking',
  CYCLING = 'cycling',
}

export class RoutingRequestDto {
  @ApiProperty({ description: 'Latitud de origen', example: -12.046374 })
  @IsNumber()
  originLat: number;

  @ApiProperty({ description: 'Longitud de origen', example: -77.042793 })
  @IsNumber()
  originLng: number;

  @ApiProperty({ description: 'Latitud de destino', example: -12.056374 })
  @IsNumber()
  destLat: number;

  @ApiProperty({ description: 'Longitud de destino', example: -77.032793 })
  @IsNumber()
  destLng: number;

  @ApiPropertyOptional({
    description: 'Perfil de enrutamiento',
    enum: RoutingProfile,
    default: RoutingProfile.DRIVING,
  })
  @IsOptional()
  @IsEnum(RoutingProfile)
  profile?: RoutingProfile = RoutingProfile.DRIVING;
}
