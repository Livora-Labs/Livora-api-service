import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateB2bApplicationDto {
  @ApiProperty({ example: 'Empresa Reciclajes S.A.', description: 'Nombre de la empresa compradora' })
  @IsNotEmpty({ message: 'companyName es requerido' })
  @IsString()
  companyName: string;

  @ApiProperty({ example: 'contacto@empresa.com', description: 'Correo de contacto' })
  @IsNotEmpty({ message: 'email es requerido' })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email: string;

  @ApiProperty({ example: 'NIT-900123456', description: 'Tax ID o Registro legal de la empresa' })
  @IsNotEmpty({ message: 'taxId es requerido' })
  @IsString()
  taxId: string;
}
