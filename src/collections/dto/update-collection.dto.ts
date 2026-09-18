import { ApiPropertyOptional } from '@nestjs/swagger';
import { RequestStatus } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCollectionDto {
  @ApiPropertyOptional({
    enum: RequestStatus,
    description: 'Nuevo estado de la recolección',
  })
  @IsOptional()
  @IsEnum(RequestStatus, {
    message: 'status debe ser un valor válido del enum RequestStatus',
  })
  status?: RequestStatus;

  @ApiPropertyOptional({
    description: 'Diccionario con pesos o cantidades estimadas por material',
    example: { PET: 4.5, Carton: 2.0 },
  })
  @IsOptional()
  @IsObject({ message: 'itemsEstimated debe ser un objeto JSON válido' })
  itemsEstimated?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Descripción o indicaciones actualizadas para la recolección',
    example: 'Bolsas blancas dejadas junto a la puerta principal.',
  })
  @IsOptional()
  @IsString({ message: 'description debe ser una cadena de texto' })
  @MaxLength(500, { message: 'description no puede exceder 500 caracteres' })
  description?: string;
}
