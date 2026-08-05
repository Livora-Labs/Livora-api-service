import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Número de página' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero' })
  @Min(1, { message: 'page debe ser mayor o igual a 1' })
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, description: 'Límite de elementos por página' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit debe ser un número entero' })
  @Min(1, { message: 'limit debe ser mayor o igual a 1' })
  @Max(100, { message: 'limit no puede ser mayor a 100' })
  limit?: number = 20;

  @ApiPropertyOptional({ default: 'createdAt', description: 'Campo por el cual ordenar' })
  @IsOptional()
  @IsString({ message: 'sortBy debe ser una cadena de texto' })
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.DESC, description: 'Orden ascendente (ASC) o descendente (DESC)' })
  @IsOptional()
  @IsEnum(SortOrder, { message: 'sortOrder debe ser ASC o DESC' })
  sortOrder?: SortOrder = SortOrder.DESC;
}
