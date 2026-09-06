import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RateCollectionDto {
  @ApiProperty({
    description: 'Calificación del servicio de 1 a 5 estrellas',
    example: 5,
    minimum: 1,
    maximum: 5,
  })
  @IsNotEmpty({ message: 'El rating es requerido' })
  @IsInt({ message: 'El rating debe ser un número entero' })
  @Min(1, { message: 'El rating mínimo es 1 estrella' })
  @Max(5, { message: 'El rating máximo es 5 estrellas' })
  rating: number;

  @ApiPropertyOptional({
    description: 'Comentario u opinión sobre el servicio recibido',
    example: 'Excelente atención y puntualidad en el recojo.',
  })
  @IsOptional()
  @IsString({ message: 'El feedback debe ser una cadena de texto' })
  @MaxLength(500, { message: 'El feedback no puede exceder 500 caracteres' })
  feedback?: string;
}
