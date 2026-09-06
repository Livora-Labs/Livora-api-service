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
import { IsValidWeightRecord } from '../../common/validators/is-valid-weight-record.validator';

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
  @IsValidWeightRecord(
    { min: 0.5, maxDecimalPlaces: 2 },
    {
      message: 'El peso mínimo por material es de 0.5 kg y no debe tener más de 2 decimales',
    },
  )
  itemsEstimated: Record<string, any>;

  @ApiPropertyOptional({
    enum: ['AUTOMATIC', 'AUCTION'],
    default: 'AUTOMATIC',
    description: 'Modalidad de asignación: AUTOMATIC (primer acopio) o AUCTION (subasta de tarifas)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    let v = value;
    if (v && typeof v === 'object' && 'value' in v) {
      v = v.value;
    }
    if (typeof v === 'string') {
      const upper = v.trim().toUpperCase();
      if (upper === 'SUBASTA' || upper === 'AUCTION') return 'AUCTION';
      if (upper === 'AUTOMATIC' || upper === 'AUTOMATICO') return 'AUTOMATIC';
    }
    return v;
  })
  @IsString()
  assignmentMode?: 'AUTOMATIC' | 'AUCTION';

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
