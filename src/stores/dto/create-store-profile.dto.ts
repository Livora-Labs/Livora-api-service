import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateStoreProfileDto {
  @ApiProperty({
    example: 'Eco Tienda Orgánica S.A.C.',
    description: 'Nombre comercial o razón social de la tienda',
  })
  @IsNotEmpty({ message: 'businessName es obligatorio' })
  @IsString({ message: 'businessName debe ser un texto' })
  businessName: string;

  @ApiProperty({
    example: '20601234567',
    description: 'Registro Único de Contribuyentes (RUC) de la tienda',
  })
  @IsNotEmpty({ message: 'ruc es obligatorio' })
  @IsString({ message: 'ruc debe ser un texto' })
  ruc: string;

  @ApiProperty({
    example: 'Av. Larco 123, Miraflores, Lima',
    description: 'Dirección física de la tienda',
  })
  @IsNotEmpty({ message: 'address es obligatorio' })
  @IsString({ message: 'address debe ser un texto' })
  address: string;

  @ApiProperty({
    example: 'BCP - CCI: 002-191001234567890-54',
    description: 'Cuenta bancaria o CCI para recibir las liquidaciones',
  })
  @IsNotEmpty({ message: 'bankAccount es obligatorio' })
  @IsString({ message: 'bankAccount debe ser un texto' })
  bankAccount: string;

  @ApiPropertyOptional({
    example: 'https://mi-tienda.com/logo.png',
    description: 'URL del logo de la tienda',
  })
  @IsOptional()
  @IsUrl({}, { message: 'logoUrl debe ser una URL válida' })
  logoUrl?: string;
}
