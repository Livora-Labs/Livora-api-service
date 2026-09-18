import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateKycApplicationDto {
  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/kyc/doc123.pdf',
    description: 'URL del documento de identidad (frente)',
  })
  @IsOptional()
  @IsString()
  documentUrl?: string;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/kyc/doc123_back.jpg',
    description: 'URL del reverso del documento de identidad',
  })
  @IsOptional()
  @IsString()
  documentUrlBack?: string;

  @ApiPropertyOptional({
    example: 'https://storage.supabase.co/kyc/selfie123.jpg',
    description: 'Foto de perfil / selfie obligatoria del recolector',
  })
  @IsOptional()
  @IsString()
  selfieUrl?: string;

  @ApiPropertyOptional({
    example: '45678912',
    description: 'Número de documento de identidad',
  })
  @IsOptional()
  @IsString()
  documentNumber?: string;

  @ApiPropertyOptional({
    example: 'Mototaxi de carga / Triciclo',
    description: 'Tipo de movilidad o transporte del recolector',
  })
  @IsOptional()
  @IsString()
  transportType?: string;

  @ApiPropertyOptional({
    example: 'ABC-123',
    description: 'Placa vehicular (si aplica)',
  })
  @IsOptional()
  @IsString()
  vehiclePlate?: string;

  @ApiPropertyOptional({
    example: 'Asociación de Recicladores San Juan',
    description: 'Nombre de asociación de recicladores formalizada',
  })
  @IsOptional()
  @IsString()
  associationName?: string;

  @ApiPropertyOptional({
    example: '20123456789',
    description: 'RUC de empresa o centro de acopio',
  })
  @IsOptional()
  @IsString()
  taxIdRuc?: string;

  @ApiPropertyOptional({
    example: 'Recicladora del Norte SAC',
    description: 'Razón social registrada ante SUNAT',
  })
  @IsOptional()
  @IsString()
  businessName?: string;

  @ApiPropertyOptional({
    example: '00219400123456789012',
    description: 'Código de Cuenta Interbancaria (CCI)',
  })
  @IsOptional()
  @IsString()
  bankCci?: string;
}
