import {
  Controller,
  Post,
  Req,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
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
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: {
          type: 'string',
          enum: ['collection', 'kyc', 'receipt'],
          default: 'collection',
        },
      },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 201,
    description: '{ url, purpose, mimeType, size }',
  })
  async upload(
    @Req() req: FastifyRequest & { incomingFile?: Express.Multer.File },
    @Body('purpose') purpose?: string,
  ) {
    const file = req.incomingFile;
    if (!file) {
      throw new BadRequestException(
        'No se recibió ningún archivo. Envía la imagen en el campo "file" como multipart/form-data.',
      );
    }
    return this.uploadsService.upload(file, purpose);
  }
}
