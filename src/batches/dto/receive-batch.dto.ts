import { IsNotEmpty, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReceiveBatchDto {
  @ApiProperty({
    example: { PET: 2.5, PLASTIC: 1.0, GLASS: 3.0 },
    description: 'Pesaje industrial real por tipo de material (kg)',
  })
  @IsObject()
  @IsNotEmpty()
  materialsActual: Record<string, any>;
}
