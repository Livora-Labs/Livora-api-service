import { IsNotEmpty, IsObject } from 'class-validator';
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
}
