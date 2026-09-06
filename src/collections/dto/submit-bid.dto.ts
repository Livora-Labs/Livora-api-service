import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import { IsValidWeightRecord } from '../../common/validators/is-valid-weight-record.validator';

export class SubmitBidDto {
  @ApiPropertyOptional({
    example: { PET: 1.20, CARTON: 0.60 },
    description: 'Tarifas propuestas por kg en PEN para esta solicitud. Si se omite, se usa el tarifario registrado del Acopio.',
  })
  @IsOptional()
  @IsObject()
  @IsValidWeightRecord(
    { min: 0.05, maxDecimalPlaces: 2, allowEmpty: true },
    {
      message: 'Cada tarifa propuesta debe ser de al menos 0.05 PEN y no tener más de 2 decimales',
    },
  )
  proposedRates?: Record<string, number>;
}
