import { IsEthereumAddress, IsNotEmpty, IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTransactionDto {
  @ApiProperty({ example: '0x1234567890abcdef1234567890abcdef12345678', description: 'Dirección destino (wallet) de la red Arbitrum' })
  @IsNotEmpty({ message: 'toAddress es obligatorio' })
  @IsEthereumAddress({ message: 'toAddress debe ser una dirección ethereum (0x...) válida' })
  toAddress: string;

  @ApiProperty({ example: 50, description: 'Cantidad de EcoTokens a transferir' })
  @IsNotEmpty({ message: 'amount es obligatorio' })
  @IsNumber({}, { message: 'amount debe ser un número' })
  @IsPositive({ message: 'amount debe ser un número positivo' })
  amount: number;
}
