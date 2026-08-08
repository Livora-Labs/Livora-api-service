import { IsArray, IsNotEmpty, IsNumber, IsPositive, IsString, IsUUID, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

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

export class CreateB2bTransferDto {
  @ApiProperty({
    description: 'Lista de materiales con sus pesos a transferir',
    type: [MaterialLineDto],
    example: [{ material: 'PET', weightKg: 100 }, { material: 'CARTON', weightKg: 50 }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MaterialLineDto)
  materials: MaterialLineDto[];

  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000', description: 'ID de la empresa B2B compradora' })
  @IsNotEmpty({ message: 'buyerId es requerido' })
  @IsUUID('4')
  buyerId: string;
}
