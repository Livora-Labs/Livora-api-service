import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, Min } from 'class-validator';

export class CreatePaymentSessionDto {
  @ApiProperty({
    example: 10.0,
    description: 'Monto a recargar en Soles (PEN). 1 PEN = 1 EcoToken.',
  })
  @IsNumber()
  @IsPositive()
  @Min(1.0, { message: 'El monto mínimo de recarga es S/ 1.00 PEN' })
  amount: number;
}
