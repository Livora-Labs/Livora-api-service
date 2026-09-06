import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class ProcessPaymentWebhookDto {
  @ApiProperty({
    example: '171890123456',
    description: 'Número de compra único correlativo',
  })
  @IsNotEmpty()
  @IsString()
  purchaseNumber: string;

  @ApiProperty({
    example: 'valid_signature_hash_hex',
    description: 'Firma criptográfica HMAC-SHA256 del webhook de Niubiz',
  })
  @IsNotEmpty()
  @IsString()
  signature: string;

  @ApiPropertyOptional({
    example: 'tok_test_123456',
    description: 'Token de transacción generado por Niubiz',
  })
  @IsOptional()
  @IsString()
  transactionToken?: string;

  @ApiPropertyOptional({
    example: 10.0,
    description: 'Monto pagado en PEN',
  })
  @IsOptional()
  @IsNumber()
  amount?: number;
}
