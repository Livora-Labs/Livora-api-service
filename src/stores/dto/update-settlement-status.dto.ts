import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';
import { SettlementStatus } from '@prisma/client';

export class UpdateSettlementStatusDto {
  @ApiProperty({
    enum: SettlementStatus,
    description: 'Nuevo estado de la solicitud de liquidación',
    example: SettlementStatus.APPROVED_PENDING_PAYMENT,
  })
  @IsEnum(SettlementStatus, {
    message:
      'status debe ser un valor válido de SettlementStatus (PENDING, APPROVED_PENDING_PAYMENT, PAID, REJECTED)',
  })
  @IsNotEmpty()
  status: SettlementStatus;

  @ApiPropertyOptional({
    description: 'URL del comprobante bancario (requerido si el estado pasa a PAID)',
    example:
      'https://supabase.co/storage/v1/object/public/receipts/comprobante-bancario-123.pdf',
  })
  @IsOptional()
  @IsUrl({}, { message: 'receiptUrl debe ser una URL válida' })
  receiptUrl?: string;

  @ApiPropertyOptional({
    description: 'Motivo de rechazo de la liquidación (en caso de REJECTED)',
    example: 'Cuenta bancaria no coincide con el RUC de la tienda asociada.',
  })
  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
