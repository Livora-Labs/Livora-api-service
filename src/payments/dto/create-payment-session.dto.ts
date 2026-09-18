import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreatePaymentSessionDto {
  @ApiPropertyOptional({
    example: 20.0,
    description: 'Monto a recargar en Soles (PEN). 1 PEN = 1 EcoToken. Rango: S/ 10.00 a S/ 500.00.',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(10.0, { message: 'El monto mínimo de recarga es S/ 10.00 PEN' })
  @Max(500.0, { message: 'El monto máximo por recarga es S/ 500.00 PEN' })
  amount?: number;

  @ApiPropertyOptional({
    example: 20.0,
    description: 'Alias de amount (amountInSoles) según especificación REST V4. Rango: S/ 10.00 a S/ 500.00.',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(10.0, { message: 'El monto mínimo de recarga es S/ 10.00 PEN' })
  @Max(500.0, { message: 'El monto máximo por recarga es S/ 500.00 PEN' })
  amountInSoles?: number;

  @ApiPropertyOptional({
    example: 'usuario@ejemplo.com',
    description: 'Correo electrónico del pagador (opcional, por defecto el del usuario autenticado)',
  })
  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @ApiPropertyOptional({
    example: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    description: 'Dirección de wallet destino (opcional, por defecto la del usuario autenticado)',
  })
  @IsOptional()
  @IsString()
  userWalletAddress?: string;

  /**
   * Obtiene el monto efectivo de la transacción asegurando el mínimo de S/ 10.00
   */
  getEffectiveAmount(): number {
    const val = this.amount ?? this.amountInSoles ?? 10.0;
    return Number(val);
  }
}
