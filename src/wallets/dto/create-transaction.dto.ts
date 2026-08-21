import {
  Matches,
  IsNotEmpty,
  IsNumber,
  IsPositive,
} from 'class-validator';
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
  @IsNumber({}, { message: 'amount debe ser un número' })
  @IsPositive({ message: 'amount debe ser un número positivo' })
  amount: number;
}
