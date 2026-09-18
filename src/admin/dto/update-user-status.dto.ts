import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';

export class UpdateUserStatusDto {
  @ApiPropertyOptional({
    example: true,
    description: 'Estado activo o deshabilitado del usuario',
  })
  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser un valor booleano' })
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: UserStatus,
    description: 'Estado operativo del usuario en el ciclo de vida de la cuenta',
  })
  @IsOptional()
  @IsEnum(UserStatus, { message: 'userStatus debe ser un estado válido de UserStatus' })
  userStatus?: UserStatus;
}
