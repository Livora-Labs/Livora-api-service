import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateComplaintDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['DNI', 'CE', 'PASAPORTE', 'RUC'], {
    message: 'documentType debe ser DNI, CE, PASAPORTE o RUC',
  })
  documentType: string;

  @IsString()
  @IsNotEmpty()
  documentNumber: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsEmail({}, { message: 'El correo electrónico debe ser válido' })
  @IsNotEmpty()
  email: string;

  @IsOptional()
  @IsBoolean()
  isMinor?: boolean;

  @IsOptional()
  @IsString()
  representativeName?: string;

  @IsOptional()
  @IsString()
  representativeDoc?: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['PRODUCTO', 'SERVICIO'], {
    message: 'goodType debe ser PRODUCTO o SERVICIO',
  })
  goodType: string;

  @IsString()
  @IsNotEmpty()
  goodDescription: string;

  @IsOptional()
  @IsNumber({}, { message: 'amount debe ser un número válido' })
  @Min(0, { message: 'El monto reclamado no puede ser negativo' })
  amount?: number;

  @IsString()
  @IsNotEmpty()
  @IsIn(['RECLAMO', 'QUEJA'], {
    message: 'claimType debe ser RECLAMO o QUEJA',
  })
  claimType: string;

  @IsString()
  @IsNotEmpty()
  claimDetail: string;

  @IsString()
  @IsNotEmpty()
  consumerRequest: string;

  @IsOptional()
  @IsUUID('all', { message: 'userId debe ser un UUID válido' })
  userId?: string;
}
