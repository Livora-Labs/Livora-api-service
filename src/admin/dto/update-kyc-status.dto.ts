import { IsEnum, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { KycStatus } from '@prisma/client';

export class UpdateKycStatusDto {
  @ApiProperty({ enum: KycStatus, example: KycStatus.APPROVED, description: 'Nuevo estado KYC (APPROVED, REJECTED)' })
  @IsNotEmpty({ message: 'status es requerido' })
  @IsEnum(KycStatus, { message: 'status debe ser PENDING, APPROVED o REJECTED' })
  status: KycStatus;
}
