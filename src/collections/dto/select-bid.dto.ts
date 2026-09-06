import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class SelectBidDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'ID de la propuesta (AcopioBid) seleccionada por el Hogar',
  })
  @IsNotEmpty({ message: 'bidId es requerido' })
  @IsUUID('4', { message: 'bidId debe ser un UUID válido' })
  bidId: string;
}
