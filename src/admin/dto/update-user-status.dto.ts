import { IsBoolean, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserStatusDto {
  @ApiProperty({
    example: true,
    description: 'Estado activo o deshabilitado del usuario',
  })
  @IsNotEmpty({ message: 'isActive es requerido' })
  @IsBoolean({ message: 'isActive debe ser un valor booleano' })
  isActive: boolean;
}
