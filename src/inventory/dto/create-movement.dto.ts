import { IsEnum, IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MovementType } from '@prisma/client';

export class CreateMovementDto {
  @ApiProperty({ enum: MovementType, example: MovementType.IN, description: 'Tipo de movimiento (IN o OUT)' })
  @IsNotEmpty({ message: 'type es requerido' })
  @IsEnum(MovementType, { message: 'type debe ser IN u OUT' })
  type: MovementType;

  @ApiProperty({ example: 120.5, description: 'Cantidad en kilogramos del material' })
  @IsNotEmpty({ message: 'quantityKg es requerido' })
  @IsNumber({}, { message: 'quantityKg debe ser un número' })
  @IsPositive({ message: 'quantityKg debe ser un número positivo' })
  quantityKg: number;

  @ApiProperty({ example: 'PET', description: 'Tipo de material reciclable' })
  @IsNotEmpty({ message: 'materialType es requerido' })
  @IsString({ message: 'materialType debe ser una cadena de texto' })
  materialType: string;
}
