import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ComplaintStatus } from '@prisma/client';

export class UpdateComplaintStatusDto {
  @ApiProperty({
    enum: ComplaintStatus,
    description: 'Nuevo estado de la reclamación (IN_PROGRESS, RESOLVED, CLOSED)',
    example: ComplaintStatus.RESOLVED,
  })
  @IsEnum(ComplaintStatus, {
    message:
      'status debe ser un valor válido de ComplaintStatus (OPEN, IN_PROGRESS, RESOLVED, CLOSED)',
  })
  @IsNotEmpty()
  status: ComplaintStatus;

  @ApiPropertyOptional({
    description:
      'Nota o sustento legal de la respuesta oficial a la reclamación conforme a la Ley 29571',
    example:
      'Se procedió con la atención y subsanación conforme a la Ley N.º 29571 y Ley N.º 32495.',
  })
  @IsOptional()
  @IsString()
  legalResponseNote?: string;
}
