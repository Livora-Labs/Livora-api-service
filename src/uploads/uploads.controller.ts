import {
  Controller,
  Post,
  Get,
  Req,
  Res,
  Query,
  Body,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest, FastifyReply } from 'fastify';
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
      'Subir un archivo (foto de recolección, documento KYC o recibo). Devuelve la URL pública o ruta segura.',
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
    return this.uploadsService.upload(file, purpose, (req as any).user?.id);
  }

  @Get('secure-view')
  @ApiOperation({
    summary: 'Streaming proxy seguro para visualización de documentos y fotos protegidas con control RBAC',
  })
  async secureView(
    @Query('path') path: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    if (!path) {
      throw new BadRequestException('El parámetro "path" es obligatorio');
    }

    const user = (req as any).user;
    if (!user) {
      throw new ForbiddenException('Sesión no válida o usuario no autenticado');
    }

    // Regla de seguridad RBAC / Multitenancy:
    // Si el archivo pertenece al bucket privado de KYC o tiene estructura de ruta de KYC (donde la carpeta raíz suele ser el userId),
    // solo administradores/auditores o el propietario exacto del documento pueden acceder a su flujo binario.
    const isKycOrPrivate =
      path.includes('livora-kyc-private') ||
      path.includes('/object/sign/') ||
      (!path.startsWith('collection/') && !path.startsWith('receipt/') && !path.includes('livora-uploads'));

    if (isKycOrPrivate) {
      const isPrivilegedRole =
        user.role === 'ADMIN' ||
        user.role === 'AUDITOR' ||
        user.role === 'SUPER_ADMIN';

      const isDocumentOwner =
        path.includes(user.id) ||
        (user.email && path.includes(encodeURIComponent(user.email)));

      if (!isPrivilegedRole && !isDocumentOwner) {
        throw new ForbiddenException(
          'Acceso denegado: No tienes privilegios suficientes para inspeccionar este documento confidencial.',
        );
      }
    }

    const { buffer, mimeType, size } = await this.uploadsService.getFileStream(path);

    reply
      .header('Content-Type', mimeType)
      .header('Content-Length', size)
      .header('Cache-Control', 'private, no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  }
}
