import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, Min } from 'class-validator';

export class CreateSettlementRequestDto {
  @ApiProperty({ example: 50, description: 'Monto de EcoTokens a liquidar (mínimo 50)' })
  @IsNotEmpty({ message: 'tokenAmount es obligatorio' })
  @IsNumber({}, { message: 'tokenAmount debe ser un número' })
  @Min(50, { message: 'El monto mínimo de liquidación es de 50 EcoTokens' })
  tokenAmount: number;
}
