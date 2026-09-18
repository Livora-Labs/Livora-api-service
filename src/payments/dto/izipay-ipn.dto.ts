import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class IzipayIpnDto {
  @ApiProperty({
    description: 'Respuesta JSON con el detalle y estado de la orden procesada por Izipay',
  })
  @IsNotEmpty()
  'kr-answer': any;

  @ApiProperty({
    description: 'Firma criptográfica HMAC-SHA-256 calculada sobre kr-answer',
  })
  @IsString()
  @IsNotEmpty()
  'kr-hash': string;

  @ApiPropertyOptional({
    description: 'Algoritmo de cálculo de firma (HMAC-SHA-256)',
  })
  @IsOptional()
  @IsString()
  'kr-hash-algorithm'?: string;

  @ApiPropertyOptional({
    description: 'Identificador de la clave utilizada (sha256_hmac o password)',
  })
  @IsOptional()
  @IsString()
  'kr-hash-key'?: string;
}
