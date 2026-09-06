import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmPaymentDto {
  @ApiProperty({
    example: '171890123456',
    description: 'Número de compra único correlativo de 12 dígitos',
  })
  @IsNotEmpty()
  @IsString()
  purchaseNumber: string;

  @ApiProperty({
    example: 'tok_live_1234567890abcdef',
    description: 'Token de transacción generado por el formulario de pago seguro de Niubiz',
  })
  @IsNotEmpty()
  @IsString()
  transactionToken: string;
}
