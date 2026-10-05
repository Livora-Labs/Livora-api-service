import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ClaimRewardDto {
  @ApiProperty({
    example: 'STAGE_3',
    enum: ['STAGE_3', 'STAGE_4'],
    description: 'Etapa del Árbol Semanal cuya recompensa se reclama (STAGE_3: +0.50 LIVO, STAGE_4: +1.00 LIVO)',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(['STAGE_3', 'STAGE_4'], {
    message: 'La etapa debe ser STAGE_3 o STAGE_4',
  })
  stage: 'STAGE_3' | 'STAGE_4';
}
