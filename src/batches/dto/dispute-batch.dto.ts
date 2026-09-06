import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DisputeBatchDto {
  @ApiProperty({
    description: 'Justificación técnica u objeción del recolector respecto a la discrepancia de pesaje registrada por el acopio',
    example: 'El peso registrado en el domicilio era de 45.0 kg calibrado con balanza digital portátil. La merma indicada de 15 kg no corresponde a la realidad.',
  })
  @IsNotEmpty({ message: 'El motivo de la disputa es obligatorio' })
  @IsString({ message: 'El motivo debe ser una cadena de texto' })
  @MinLength(10, { message: 'El motivo de disputa debe contener al menos 10 caracteres' })
  @MaxLength(1000, { message: 'El motivo de disputa no puede exceder 1000 caracteres' })
  reason: string;
}
