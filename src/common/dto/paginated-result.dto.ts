import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ example: 45, description: 'Total de registros encontrados' })
  total: number;

  @ApiProperty({ example: 1, description: 'Página actual' })
  page: number;

  @ApiProperty({ example: 15, description: 'Límite de registros por página' })
  limit: number;

  @ApiProperty({ example: 3, description: 'Total de páginas disponibles' })
  totalPages: number;

  @ApiProperty({ example: true, description: 'Indica si existe una página subsiguiente' })
  hasNextPage: boolean;

  @ApiProperty({ example: false, description: 'Indica si existe una página previa' })
  hasPrevPage: boolean;
}

export class PaginatedResultDto<T> {
  @ApiProperty({ isArray: true, description: 'Lista de registros de la página' })
  data: T[];

  @ApiProperty({ type: () => PaginationMetaDto, description: 'Metadatos de paginación' })
  meta: PaginationMetaDto;

  constructor(data: T[], total: number, page: number, limit: number) {
    this.data = data;
    const totalPages = Math.max(1, Math.ceil(total / (limit || 15)));
    this.meta = {
      total,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
