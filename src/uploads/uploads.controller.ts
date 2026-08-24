import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { UploadsService } from './uploads.service';

@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
@UseGuards(SupabaseAuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Subir un archivo (foto de recolección, documento KYC o recibo). Devuelve la URL pública.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({
    status: 201,
    description: '{ url, purpose, mimeType, size }',
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('purpose') purpose?: string,
  ) {
    return this.uploadsService.upload(file, purpose);
  }
}
