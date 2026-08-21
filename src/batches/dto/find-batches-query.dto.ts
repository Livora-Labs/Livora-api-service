import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BatchStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class FindBatchesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: BatchStatus,
    description: 'Estado del lote para filtrado',
  })
  @IsOptional()
  @IsEnum(BatchStatus, {
    message: 'status debe ser un valor válido del enum BatchStatus',
  })
  status?: BatchStatus;

  @ApiPropertyOptional({ description: 'ID del recolector (UUID)' })
  @IsOptional()
  @IsUUID('4', { message: 'collectorId debe ser un UUID v4 válido' })
  collectorId?: string;

  @ApiPropertyOptional({
    description: 'ID del centro de acopio destino (UUID)',
  })
  @IsOptional()
  @IsUUID('4', { message: 'destinationCenterId debe ser un UUID v4 válido' })
  destinationCenterId?: string;
}
