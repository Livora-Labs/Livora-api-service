import { IsString, MinLength, Matches, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'CurrentPassword123!',
    description: 'Contraseña actual del usuario autenticado',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña actual es requerida' })
  currentPassword: string;

  @ApiProperty({
    example: 'NewSecurePassword123!',
    description:
      'Nueva contraseña del usuario (mínimo 8 caracteres, mayúscula, minúscula, número y símbolo especial)',
  })
  @IsString()
  @MinLength(8, { message: 'La nueva contraseña debe tener al menos 8 caracteres' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>_+\-=[\]\\/])[A-Za-z\d!@#$%^&*(),.?":{}|<>_+\-=[\]\\/]{8,}$/,
    {
      message:
        'La nueva contraseña debe contener al menos una mayúscula, una minúscula, un número y un símbolo especial',
    },
  )
  newPassword: string;
}
