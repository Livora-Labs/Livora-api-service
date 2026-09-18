import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';

export class UpdateKycStatusDto {
  @ApiProperty({
    enum: KycStatus,
    example: KycStatus.APPROVED,
    description: 'Nuevo estado KYC (PENDING, OBSERVED, IN_REVIEW, APPROVED, REJECTED, EXPIRED)',
  })
  @IsNotEmpty({ message: 'status es requerido' })
  @IsEnum(KycStatus, {
    message: 'status debe ser PENDING, OBSERVED, IN_REVIEW, APPROVED, REJECTED o EXPIRED',
  })
  status: KycStatus;

  @ApiPropertyOptional({
    description: 'Notas u observaciones del auditor para solicitudes observadas o rechazadas',
    example: 'El documento de identidad está borroso o ilegible. Por favor reintentar subiendo una foto nítida.',
  })
  @IsOptional()
  @IsString()
  observationNotes?: string;
}
