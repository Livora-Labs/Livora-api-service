import { IsNotEmpty, IsNumber, IsPositive, IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateSaleDto {
  @ApiProperty({ example: 'PET', description: 'Tipo de material vendido' })
  @IsNotEmpty({ message: 'materialType es requerido' })
  @IsString({ message: 'materialType debe ser una cadena de texto' })
  materialType: string;

  @ApiProperty({ example: 500.0, description: 'Peso total vendido en kilogramos' })
  @IsNotEmpty({ message: 'weightKg es requerido' })
  @IsNumber({}, { message: 'weightKg debe ser un número' })
  @IsPositive({ message: 'weightKg debe ser positivo' })
  weightKg: number;

  @ApiProperty({ example: 1250.0, description: 'Monto total acordado de la venta en USD / Token' })
  @IsNotEmpty({ message: 'totalAmount es requerido' })
  @IsNumber({}, { message: 'totalAmount debe ser un número' })
  @IsPositive({ message: 'totalAmount debe ser positivo' })
  totalAmount: number;

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000', description: 'ID (UUID) de la empresa compradora B2B' })
  @IsNotEmpty({ message: 'buyerId es requerido' })
  @IsUUID('4', { message: 'buyerId debe ser un UUID v4 válido' })
  buyerId: string;
}
