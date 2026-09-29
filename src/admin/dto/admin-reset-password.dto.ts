import { IsString, IsOptional, IsBoolean, MinLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AdminResetPasswordDto {
  @ApiPropertyOptional({
    description:
      'Nueva contraseña asignada manualmente por el administrador (mínimo 8 caracteres, mayúscula, minúscula, número y símbolo especial)',
    example: 'NuevaClave2026!',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'La nueva contraseña debe tener al menos 8 caracteres' })
  @Matches(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>_+\-=[\]\\/])[A-Za-z\d!@#$%^&*(),.?":{}|<>_+\-=[\]\\/]{8,}$/,
    {
      message:
        'La contraseña debe contener al menos una mayúscula, una minúscula, un número y un símbolo especial',
    },
  )
  newPassword?: string;

  @ApiPropertyOptional({
    description:
      'Si es true, despacha un correo oficial de recuperación de contraseña con enlace web al usuario',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  sendResetEmail?: boolean;
}
