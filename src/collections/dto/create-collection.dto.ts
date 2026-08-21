import { Transform, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCollectionDto {
  @ApiProperty({
    example: { PET: 2.5, PLASTIC: 1.0, GLASS: 3.0 },
    description: 'Objeto JSON con los materiales y pesos estimados (kg)',
  })
  @IsNotEmpty({ message: 'itemsEstimated es requerido' })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsObject({ message: 'itemsEstimated debe ser un objeto JSON válido' })
  itemsEstimated: Record<string, any>;

  @ApiPropertyOptional({
    example: 'Bolsa blanca afuera de la puerta',
    description: 'Notas opcionales para el recolector',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 4.6097, description: 'Latitud GPS' })
  @IsNotEmpty({ message: 'latitude es requerida' })
  @Type(() => Number)
  @IsNumber({}, { message: 'latitude debe ser un número' })
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ example: -74.0817, description: 'Longitud GPS' })
  @IsNotEmpty({ message: 'longitude es requerida' })
  @Type(() => Number)
  @IsNumber({}, { message: 'longitude debe ser un número' })
  @Min(-180)
  @Max(180)
  longitude: number;

  @ApiPropertyOptional({
    example: 'https://...',
    description: 'URL de la foto opcional',
  })
  @IsOptional()
  @IsString()
  photoUrl?: string;
}
