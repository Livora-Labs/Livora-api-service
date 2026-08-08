import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyPinDto {
  @ApiProperty({ example: '4829', description: 'PIN secreto de 4 dígitos proporcionado por el Hogar' })
  @IsNotEmpty({ message: 'El PIN de verificación es requerido' })
  @IsString({ message: 'El PIN debe ser una cadena de texto' })
  @Length(4, 4, { message: 'El PIN debe tener exactamente 4 dígitos' })
  pin: string;
}
