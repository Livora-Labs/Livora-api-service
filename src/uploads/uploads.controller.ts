import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
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
  @ApiResponse({ status: 201, description: '{ url, purpose, mimeType, size }' })
  async upload(
    @Req() req: FastifyRequest,
    @Body('purpose') purpose?: string,
  ) {
    // @fastify/multipart está registrado globalmente (attachFieldsToBody +
    // onFile), por lo que el archivo llega en req.incomingFile y los campos de
    // texto (purpose) en el body. No se usa FileInterceptor (era de Express).
    const file = (req as unknown as {
      incomingFile?: {
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size: number;
      };
    }).incomingFile;

    if (!file) {
      throw new BadRequestException(
        'No se recibió ningún archivo. Envía multipart/form-data con un campo "file".',
      );
    }

    return this.uploadsService.upload(file, purpose);
  }
}
