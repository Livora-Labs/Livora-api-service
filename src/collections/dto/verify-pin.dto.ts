import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { IsValidWeightRecord } from '../../common/validators/is-valid-weight-record.validator';

export class VerifyPinDto {
  @ApiProperty({
    example: '4829',
    description: 'PIN secreto de 4 dígitos proporcionado por el Hogar',
  })
  @IsNotEmpty({ message: 'El PIN de verificación es requerido' })
  @IsString({ message: 'El PIN debe ser una cadena de texto' })
  @Length(4, 4, { message: 'El PIN debe tener exactamente 4 dígitos' })
  pin: string;

  @ApiPropertyOptional({
    example: { PET: 10.0, CARTON: 5.0 },
    description: 'Pesos reales pesados en báscula portátil en el domicilio del Hogar (kg)',
  })
  @IsOptional()
  @IsObject({ message: 'actualWeights debe ser un objeto de pesos por material' })
  @IsValidWeightRecord(
    { min: 0.5, maxDecimalPlaces: 2, allowEmpty: true },
    {
      message: 'Cada peso real ajustado debe ser de al menos 0.5 kg y no tener más de 2 decimales',
    },
  )
  actualWeights?: Record<string, number>;
}
