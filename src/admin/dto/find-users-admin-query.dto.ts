import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Role, UserStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class FindUsersAdminQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: Role,
    description: 'Filtrar por rol de usuario',
  })
  @IsOptional()
  @IsEnum(Role, {
    message: 'role debe ser un rol válido del enum Role',
  })
  role?: Role;

  @ApiPropertyOptional({
    enum: UserStatus,
    description: 'Filtrar por estado de la cuenta',
  })
  @IsOptional()
  @IsEnum(UserStatus, {
    message: 'status debe ser un estado válido del enum UserStatus',
  })
  status?: UserStatus;

  @ApiPropertyOptional({
    description: 'Término de búsqueda (email, nombre, billetera o teléfono)',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
