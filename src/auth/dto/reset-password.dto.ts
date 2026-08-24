import { IsString, MinLength, Matches, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'a1b2c3d4e5f6g7h8...',
    description: 'Token hexadecimal de recuperación de contraseña',
  })
  @IsString()
  @IsNotEmpty({ message: 'El token de recuperación es requerido' })
  token: string;

  @ApiProperty({
    example: 'NewSecurePassword123!',
    description:
      'Nueva contraseña del usuario (mínimo 8 caracteres, mayúscula, minúscula, número y símbolo)',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/])[A-Za-z\d!@#$%^&*(),.?":{}|<>_+\-=\[\]\\/]{8,}$/,
    {
      message:
        'La contraseña debe contener al menos una mayúscula, una minúscula, un número y un símbolo especial',
    },
  )
  password: string;
}
