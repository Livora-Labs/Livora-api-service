import { Matches, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTransactionDto {
  @ApiProperty({
    example: 'GA3LZ7ROA3YAYOY52J5TDLDDMDADCCZ3CV6CXVQE4SUQGCAB732QXGEB',
    description: 'Dirección destino (wallet) de la red Stellar',
  })
  @IsNotEmpty({ message: 'toAddress es obligatorio' })
  @Matches(/^G[A-D2-7][A-Z2-7]{54}$/, {
    message: 'toAddress debe ser una dirección Stellar pública (G...) válida',
  })
  toAddress: string;

  @ApiProperty({
    example: 50,
    description: 'Cantidad de EcoTokens a transferir',
  })
  @IsNotEmpty({ message: 'amount es obligatorio' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser un número con máximo 2 decimales' })
  @Min(0.10, { message: 'El monto mínimo de transferencia es de 0.10 ECO' })
  amount: number;
}
