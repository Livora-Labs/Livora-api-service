import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, IsOptional } from 'class-validator';

export class CreateQrRedemptionDto {
  @ApiProperty({ example: 15.5, description: 'Monto de EcoTokens a canjear (tokenAmount)' })
  @IsOptional()
  @IsNumber({}, { message: 'tokenAmount debe ser un número' })
  @IsPositive({ message: 'tokenAmount debe ser positivo' })
  tokenAmount?: number;

  @ApiProperty({ example: 15.5, description: 'Monto de EcoTokens a canjear (amount)' })
  @IsOptional()
  @IsNumber({}, { message: 'amount debe ser un número' })
  @IsPositive({ message: 'amount debe ser positivo' })
  amount?: number;
}
