import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ComplaintStatus } from '@prisma/client';

export class UpdateComplaintStatusDto {
  @ApiProperty({
    enum: ComplaintStatus,
    example: ComplaintStatus.RESOLVED,
    description:
      'Nuevo estado de la queja (OPEN, IN_PROGRESS, RESOLVED, CLOSED)',
  })
  @IsNotEmpty({ message: 'status es requerido' })
  @IsEnum(ComplaintStatus, {
    message: 'status debe ser un valor del enum ComplaintStatus',
  })
  status: ComplaintStatus;
}
