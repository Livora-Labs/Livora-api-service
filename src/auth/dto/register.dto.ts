import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
  Matches,
  IsBoolean,
} from 'class-validator';
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
    description:
      'Contraseña del usuario (mínimo 8 caracteres, mayúscula, minúscula, número y símbolo)',
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

  @ApiProperty({
    example: '1.0.0',
    description: 'Versión de Términos y Condiciones aceptados',
    required: false,
  })
  @IsOptional()
  @IsString()
  termsVersion?: string;

  @ApiProperty({
    example: '1.0.0',
    description: 'Versión de Política de Privacidad aceptada (Ley 29733)',
    required: false,
  })
  @IsOptional()
  @IsString()
  privacyVersion?: string;

  @ApiProperty({
    example: 'a1b2c3d4e5f6...',
    description: 'Hash SHA-256 del documento de consentimiento',
    required: false,
  })
  @IsOptional()
  @IsString()
  documentHash?: string;

  @ApiProperty({
    example: '190.236.1.100',
    description: 'Dirección IP del cliente al momento del consentimiento',
    required: false,
  })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiProperty({
    example: 'Mozilla/5.0 ...',
    description: 'User Agent del cliente',
    required: false,
  })
  @IsOptional()
  @IsString()
  userAgent?: string;

  @ApiProperty({
    example: true,
    description: 'Indica si el usuario autoriza fines publicitarios y de marketing (Ley 29733)',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  marketingAccepted?: boolean;
}
