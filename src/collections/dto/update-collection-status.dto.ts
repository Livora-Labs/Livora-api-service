import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RequestStatus } from '@prisma/client';

export class UpdateCollectionStatusDto {
  @ApiProperty({
    enum: RequestStatus,
    example: RequestStatus.ACCEPTED,
    description: 'Nuevo estado (ej. ACCEPTED, COLLECTED, CANCELLED)',
  })
  @IsNotEmpty({ message: 'status es requerido' })
  @IsEnum(RequestStatus, {
    message: 'status debe ser un valor válido del enum RequestStatus',
  })
  status: RequestStatus;
}
