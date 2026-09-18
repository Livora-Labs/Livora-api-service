import { IsNotEmpty, IsNumber, IsObject, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsValidWeightRecord } from '../../common/validators/is-valid-weight-record.validator';

export class ReceiveBatchDto {
  @ApiProperty({
    example: { PET: 2.5, PLASTIC: 1.0, GLASS: 3.0 },
    description: 'Pesaje industrial real por tipo de material (kg)',
  })
  @IsObject()
  @IsNotEmpty()
  @IsValidWeightRecord(
    { min: 0.5, maxDecimalPlaces: 2 },
    {
      message: 'Cada material en pesaje real debe ser de al menos 0.5 kg y no tener más de 2 decimales',
    },
  )
  materialsActual: Record<string, any>;

  @ApiProperty({ required: false, example: 25.0, description: 'Peso neto útil aceptado en kg' })
  @IsOptional()
  @IsNumber()
  usefulWeightKg?: number;

  @ApiProperty({ required: false, example: 3.5, description: 'Peso de merma / material contaminado en kg' })
  @IsOptional()
  @IsNumber()
  wasteWeightKg?: number;
}
