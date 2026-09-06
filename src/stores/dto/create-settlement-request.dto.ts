import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, Matches, Min } from 'class-validator';

export class CreateSettlementRequestDto {
  @ApiProperty({
    example: 50,
    description: 'Monto de EcoTokens a liquidar (mínimo 50)',
  })
  @IsNotEmpty({ message: 'tokenAmount es obligatorio' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'tokenAmount debe ser un número con máximo 2 decimales' })
  @Min(50, { message: 'El monto mínimo de liquidación es de 50 EcoTokens' })
  tokenAmount: number;

  @ApiPropertyOptional({
    example: '00219100123456789054',
    description: 'Código de Cuenta Interbancario (CCI) de 20 dígitos',
  })
  @IsOptional()
  @Matches(/^\d{20}$/, {
    message: 'El CCI bancario debe contener exactamente 20 dígitos numéricos',
  })
  cci?: string;
}
