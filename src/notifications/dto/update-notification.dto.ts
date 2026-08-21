import { IsBoolean, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateNotificationDto {
  @ApiProperty({
    example: true,
    description: 'Estado de lectura de la notificación',
  })
  @IsNotEmpty({ message: 'isRead es obligatorio' })
  @IsBoolean({ message: 'isRead debe ser un valor booleano' })
  isRead: boolean;
}
