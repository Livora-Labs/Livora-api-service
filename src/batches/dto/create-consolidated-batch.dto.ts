import { ArrayMinSize, IsArray, IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateConsolidatedBatchDto {
  @ApiProperty({
    example: [
      '123e4567-e89b-12d3-a456-426614174000',
      '987e6543-e21b-12d3-a456-426614174111',
    ],
    description:
      'Lista de IDs (UUID) de lotes recibidos (RECEIVED) a consolidar',
  })
  @IsNotEmpty({ message: 'batchIds es obligatorio' })
  @IsArray({ message: 'batchIds debe ser un arreglo de strings' })
  @ArrayMinSize(1, {
    message: 'Debe proporcionar al menos un ID de lote para consolidar',
  })
  @IsUUID('4', {
    each: true,
    message: 'Cada elemento de batchIds debe ser un UUID v4 válido',
  })
  batchIds: string[];
}
