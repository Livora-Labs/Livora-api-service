import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive } from 'class-validator';

export class CreateQrRedemptionDto {
  @ApiProperty({
    example: 15.5,
    description: 'Monto de EcoTokens a canjear',
  })
  @IsNumber({}, { message: 'tokenAmount debe ser un número' })
  @IsPositive({ message: 'tokenAmount debe ser positivo' })
  tokenAmount: number;
}
