import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MaterialLineDto {
  @ApiProperty({ example: 'PET', description: 'Tipo de material' })
  @IsNotEmpty({ message: 'material es requerido' })
  @IsString()
  material: string;

  @ApiProperty({ example: 120.5, description: 'Peso en kg' })
  @IsNotEmpty({ message: 'weightKg es requerido' })
  @IsNumber()
  @IsPositive()
  weightKg: number;
}

export class CreateB2bPurchaseRequestDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'ID del centro de acopio proveedor',
  })
  @IsNotEmpty({ message: 'centerId es requerido' })
  @IsUUID('4')
  centerId: string;

  @ApiProperty({
    description: 'Lista de materiales solicitados con sus pesos estimados',
    type: [MaterialLineDto],
    example: [
      { material: 'PET', weightKg: 100 },
      { material: 'CARTON', weightKg: 50 },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MaterialLineDto)
  materials: MaterialLineDto[];

  @ApiPropertyOptional({
    example: 'Coordinar entrega en Planta Ate el viernes',
    description: 'Notas o especificaciones para el centro de acopio',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AcceptB2bTransferDto {
  @ApiProperty({
    description: 'Lista de materiales con sus pesos reales pesados y despachados',
    type: [MaterialLineDto],
    example: [
      { material: 'PET', weightKg: 102.3 },
      { material: 'CARTON', weightKg: 49.5 },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MaterialLineDto)
  actualMaterials: MaterialLineDto[];

  @ApiPropertyOptional({
    example: 'Guía de remisión T001-0004512 con precintos intactos',
    description: 'Notas de despacho o guía de remisión',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
