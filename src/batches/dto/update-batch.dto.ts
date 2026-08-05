import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateBatchDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000', description: 'ID de usuario (UUID) del Centro de Acopio destino' })
  @IsUUID('4', { message: 'destinationCenterId debe ser un UUID v4 válido' })
  @IsNotEmpty({ message: 'destinationCenterId es obligatorio' })
  destinationCenterId: string;
}

