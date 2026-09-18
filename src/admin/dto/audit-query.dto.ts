import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class LedgerAuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filtrar por Correlation ID específico' })
  @IsOptional()
  @IsString()
  correlationId?: string;

  @ApiPropertyOptional({ description: 'Filtrar por Hash de transacción Stellar' })
  @IsOptional()
  @IsString()
  txHash?: string;

  @ApiPropertyOptional({ description: 'Búsqueda por texto (descripción, correo o hash)' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ServerLogsQueryDto {
  @ApiPropertyOptional({ description: 'Nivel de severidad (ALL, INFO, WARN, ERROR)', default: 'ALL' })
  @IsOptional()
  @IsString()
  level?: string = 'ALL';

  @ApiPropertyOptional({ description: 'Filtrar por Correlation ID' })
  @IsOptional()
  @IsString()
  correlationId?: string;

  @ApiPropertyOptional({ description: 'Búsqueda por texto libre' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Límite de registros (máx 200)', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ description: 'Desplazamiento para paginación', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}
