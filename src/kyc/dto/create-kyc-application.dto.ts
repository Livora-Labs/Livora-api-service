import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateKycApplicationDto {
  @ApiPropertyOptional({ example: 'https://storage.supabase.co/kyc/doc123.pdf', description: 'URL del documento de identidad' })
  @IsOptional()
  @IsString()
  documentUrl?: string;
}
