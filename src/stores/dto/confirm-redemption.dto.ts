import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ConfirmRedemptionDto {
  @ApiProperty({
    example: true,
    description: 'Aceptación obligatoria de los Términos y Condiciones de Uso',
  })
  @IsNotEmpty({ message: 'termsAccepted es obligatorio' })
  @IsBoolean({ message: 'termsAccepted debe ser un valor booleano' })
  termsAccepted: boolean;

  @ApiProperty({
    example: false,
    description: 'Aceptación opcional de la donación de 1.00 ECO',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'donationOptIn debe ser un valor booleano' })
  donationOptIn?: boolean;

  @ApiProperty({
    example: false,
    description: 'Aceptación opcional del seguro de envío de 0.50 ECO',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'insuranceOptIn debe ser un valor booleano' })
  insuranceOptIn?: boolean;

  @IsOptional()
  @IsString({ message: 'householdUserId debe ser un string' })
  householdUserId?: string;
}
