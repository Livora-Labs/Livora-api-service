import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUrl } from 'class-validator';

export class PaySettlementDto {
  @ApiProperty({ example: 'https://supabase.co/storage/v1/object/public/receipts/comprobante-123.pdf', description: 'URL del comprobante de pago de la liquidación' })
  @IsNotEmpty({ message: 'receiptUrl es obligatorio' })
  @IsUrl({}, { message: 'receiptUrl debe ser una URL válida' })
  receiptUrl: string;
}
