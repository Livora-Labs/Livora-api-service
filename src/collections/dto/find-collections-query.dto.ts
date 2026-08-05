import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class FindCollectionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Latitud para la búsqueda geográfica (-90 a 90)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'lat debe ser un número' })
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ description: 'Longitud para la búsqueda geográfica (-180 a 180)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'lng debe ser un número' })
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional({ default: 5, description: 'Radio de búsqueda en kilómetros' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'radius debe ser un número' })
  @Min(0.1, { message: 'radius debe ser al menos 0.1 km' })
  radius?: number = 5;
}
