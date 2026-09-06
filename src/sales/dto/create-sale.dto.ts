import {
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSaleDto {
  @ApiProperty({ example: 'PET', description: 'Tipo de material vendido' })
  @IsNotEmpty({ message: 'materialType es requerido' })
  @IsString({ message: 'materialType debe ser una cadena de texto' })
  materialType: string;

  @ApiProperty({
    example: 500.0,
    description: 'Peso total vendido en kilogramos',
  })
  @IsNotEmpty({ message: 'weightKg es requerido' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'weightKg debe tener como máximo 2 decimales' })
  @Min(0.5, { message: 'El peso mínimo vendido es de 0.5 kg' })
  weightKg: number;

  @ApiProperty({
    example: 1250.0,
    description: 'Monto total acordado de la venta en USD / Token',
  })
  @IsNotEmpty({ message: 'totalAmount es requerido' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'totalAmount debe tener como máximo 2 decimales' })
  @Min(0.10, { message: 'El monto total mínimo es de 0.10' })
  totalAmount: number;

  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'ID (UUID) de la empresa compradora B2B',
  })
  @IsNotEmpty({ message: 'buyerId es requerido' })
  @IsUUID('4', { message: 'buyerId debe ser un UUID v4 válido' })
  buyerId: string;

  @ApiProperty({
    required: false,
    example: '123e4567-e89b-12d3-a456-426614174999',
    description: 'ID (UUID) opcional del lote consolidado vendido',
  })
  @IsUUID('4', { message: 'consolidatedBatchId debe ser un UUID v4 válido' })
  consolidatedBatchId?: string;
}
