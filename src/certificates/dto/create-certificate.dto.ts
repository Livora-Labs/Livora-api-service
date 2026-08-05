import { IsNotEmpty, IsObject, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCertificateDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000', description: 'ID (UUID) de la empresa compradora B2B' })
  @IsNotEmpty({ message: 'buyerId es requerido' })
  @IsUUID('4', { message: 'buyerId debe ser un UUID v4 válido' })
  buyerId: string;

  @ApiProperty({
    example: { co2SavedKg: 450, waterSavedLiters: 1200, recycledMaterial: 'PET' },
    description: 'Metadatos de impacto ambiental ESG',
  })
  @IsNotEmpty({ message: 'esgImpact es requerido' })
  @IsObject({ message: 'esgImpact debe ser un objeto JSON' })
  esgImpact: Record<string, any>;
}
