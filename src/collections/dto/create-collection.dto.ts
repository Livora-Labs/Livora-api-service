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
    let unwrapped = value;
    if (
      value &&
      typeof value === 'object' &&
      'value' in value &&
      typeof value.value === 'string'
    ) {
      unwrapped = value.value;
    }
    if (typeof unwrapped === 'string') {
      try {
        return JSON.parse(unwrapped);
      } catch {
        return unwrapped;
      }
    }
    return unwrapped;
  })
  @IsObject({ message: 'itemsEstimated debe ser un objeto JSON válido' })
  itemsEstimated: Record<string, any>;

  @ApiPropertyOptional({
    example: 'Bolsa blanca afuera de la puerta',
    description: 'Notas opcionales para el recolector',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value && typeof value === 'object' && 'value' in value) {
      return value.value;
    }
    return value;
  })
  @IsString()
  description?: string;

  @ApiProperty({ example: 4.6097, description: 'Latitud GPS' })
  @IsNotEmpty({ message: 'latitude es requerida' })
  @Transform(({ value }) => {
    if (value && typeof value === 'object' && 'value' in value) {
      return Number(value.value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return Number(value);
    }
    return value;
  })
  @Type(() => Number)
  @IsNumber({}, { message: 'latitude debe ser un número' })
  @Min(-90)
  @Max(90)
  latitude: number;

  @ApiProperty({ example: -74.0817, description: 'Longitud GPS' })
  @IsNotEmpty({ message: 'longitude es requerida' })
  @Transform(({ value }) => {
    if (value && typeof value === 'object' && 'value' in value) {
      return Number(value.value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return Number(value);
    }
    return value;
  })
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
  @Transform(({ value }) => {
    if (value && typeof value === 'object' && 'value' in value) {
      return value.value;
    }
    return value;
  })
  @IsString()
  photoUrl?: string;

  @ApiPropertyOptional({
    description: 'Archivo binario de foto adjunto (multipart)',
  })
  @IsOptional()
  file?: any;

  @ApiPropertyOptional({
    description: 'Archivo de foto adjunto alternativo (multipart)',
  })
  @IsOptional()
  photo?: any;

  @ApiPropertyOptional({
    description: 'Archivo de imagen adjunto alternativo (multipart)',
  })
  @IsOptional()
  image?: any;
}
