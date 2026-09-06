import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

export class MaterialPriceItemDto {
  @ApiProperty({ description: 'Código o tipo de material (ej. PET, CARTON, VIDRIO)', example: 'PET' })
  @IsString()
  @IsNotEmpty()
  materialType: string;

  @ApiProperty({ description: 'Precio por kilogramo en Soles (PEN)', example: 1.00 })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'pricePerKg debe ser un número con máximo 2 decimales' })
  @Min(0.05, { message: 'El precio de compra por kg debe ser mayor o igual a 0.05 PEN' })
  pricePerKg: number;
}

export class UpdatePriceListDto {
  @ApiProperty({ description: 'Lista de tarifas por material', type: [MaterialPriceItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaterialPriceItemDto)
  prices: MaterialPriceItemDto[];
}
