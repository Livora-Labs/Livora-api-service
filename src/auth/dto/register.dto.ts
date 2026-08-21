import { IsEmail, IsEnum, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({
    example: 'hogar1@livora.com',
    description: 'Correo electrónico del usuario',
  })
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Contraseña del usuario (mínimo 8 caracteres, mayúscula, minúscula, número y símbolo)',
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

  @ApiProperty({
    enum: Role,
    example: Role.HOGAR,
    description: 'Rol del usuario: HOGAR, RECOLECTOR o CENTRO_ACOPIO',
  })
  @IsEnum(Role, { message: 'El rol especificado no es válido' })
  role: Role;
}
