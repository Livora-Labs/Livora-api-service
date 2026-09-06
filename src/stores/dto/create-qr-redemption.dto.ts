import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

export class CreateQrRedemptionDto {
  @ApiProperty({
    example: 15.5,
    description: 'Monto de EcoTokens a canjear',
  })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'tokenAmount debe ser un número con máximo 2 decimales' })
  @Min(0.10, { message: 'El monto mínimo de cobro es de 0.10 ECO' })
  tokenAmount: number;
}
