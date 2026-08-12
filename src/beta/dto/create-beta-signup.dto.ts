import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class CreateBetaSignupDto {
  @ApiProperty({ example: 'hola@correo.com', description: 'Correo del interesado en la beta' })
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email: string;
}
