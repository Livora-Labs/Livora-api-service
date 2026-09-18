import { IsNotEmpty, IsString, Matches, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TrackComplaintDto {
  @ApiProperty({
    example: 'R-00001-2026',
    description: 'Número correlativo oficial de la reclamación (R-XXXXX-AAAA o Q-XXXXX-AAAA)',
  })
  @IsString()
  @IsNotEmpty({ message: 'El número correlativo es obligatorio' })
  @Matches(/^[RQ]-\d{5}-\d{4}$/, {
    message: 'El número correlativo debe tener el formato R-XXXXX-AAAA o Q-XXXXX-AAAA',
  })
  correlativeNumber: string;

  @ApiProperty({
    example: '45678901',
    description: 'Número de documento de identidad del reclamante (DNI, CE, Pasaporte o RUC)',
  })
  @IsString()
  @IsNotEmpty({ message: 'El número de documento de identidad es obligatorio' })
  @Length(4, 20, {
    message: 'El número de documento debe tener entre 4 y 20 caracteres',
  })
  documentNumber: string;
}
