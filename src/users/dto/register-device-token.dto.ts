import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PlatformType } from '@prisma/client';

export class RegisterDeviceTokenDto {
  @ApiProperty({
    description: 'Token de registro de Firebase Cloud Messaging (FCM)',
    example: 'fcm-device-token-sample-1234567890',
  })
  @IsNotEmpty({ message: 'El device token es obligatorio' })
  @IsString({ message: 'El device token debe ser un string válido' })
  token: string;

  @ApiPropertyOptional({
    description: 'Plataforma del cliente (ANDROID, IOS, WEB)',
    enum: PlatformType,
    default: PlatformType.ANDROID,
  })
  @IsOptional()
  @IsEnum(PlatformType, { message: 'Plataforma no soportada' })
  platform?: PlatformType;
}
