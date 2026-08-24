import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshDto {
  @ApiProperty({
    example: 'v1.Mr8...refresh...',
    description: 'Refresh token de la sesión de Supabase (devuelto por login / verify-email)',
  })
  @IsString({ message: 'El refresh token es requerido' })
  @IsNotEmpty({ message: 'El refresh token no puede estar vacío' })
  refreshToken: string;
}
