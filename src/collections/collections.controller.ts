import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { VerifyPinDto } from './dto/verify-pin.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  email?: string;
}

@ApiTags('Collections')
@ApiBearerAuth()
@Controller('collection-requests')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Post()
  @Roles(Role.HOGAR)
  @ApiOperation({ summary: 'Crear solicitud de recolección (Rol: HOGAR)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCollectionDto,
    @Req() req?: FastifyRequest,
  ) {
    let file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
          size?: number;
        }
      | undefined;
    let payloadDto = dto || ({} as CreateCollectionDto);

    const reqWithFile = req as unknown as {
      incomingFile?: {
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size?: number;
      };
      rawFile?: {
        originalname: string;
        mimetype: string;
        buffer: Buffer;
        size?: number;
      };
      file?:
        | (() => Promise<{
            filename: string;
            mimetype: string;
            toBuffer: () => Promise<Buffer>;
            fields?: Record<string, { value?: string }>;
          }>)
        | {
            originalname: string;
            mimetype: string;
            buffer: Buffer;
            size?: number;
          };
      isMultipart?: () => boolean;
    };

    if (reqWithFile?.incomingFile) {
      file = reqWithFile.incomingFile;
    } else if (reqWithFile?.rawFile) {
      file = reqWithFile.rawFile;
    } else if (reqWithFile?.file && typeof reqWithFile.file !== 'function') {
      file = reqWithFile.file;
    } else if (
      reqWithFile &&
      typeof reqWithFile.isMultipart === 'function' &&
      reqWithFile.isMultipart() &&
      typeof reqWithFile.file === 'function'
    ) {
      const part = await reqWithFile.file();
      if (part) {
        const buffer = await part.toBuffer();
        file = {
          originalname: part.filename,
          mimetype: part.mimetype,
          buffer,
          size: buffer.length,
        };

        const fields = part.fields;
        if (fields) {
          let itemsEstimatedParsed: Record<string, any> =
            payloadDto?.itemsEstimated || {};
          if (fields.itemsEstimated?.value) {
            try {
              const parsed = JSON.parse(fields.itemsEstimated.value);
              if (typeof parsed === 'object' && parsed !== null) {
                itemsEstimatedParsed = parsed;
              }
            } catch {
              // Fallback
            }
          }

          payloadDto = {
            itemsEstimated: itemsEstimatedParsed,
            description: fields.description?.value ?? payloadDto?.description,
            latitude: fields.latitude?.value
              ? Number(fields.latitude.value)
              : payloadDto?.latitude,
            longitude: fields.longitude?.value
              ? Number(fields.longitude.value)
              : payloadDto?.longitude,
            photoUrl: fields.photoUrl?.value ?? payloadDto?.photoUrl,
          };
        }
      }
    }

    return this.collectionsService.create(user.id, payloadDto, file);
  }

  @Get()
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Listar solicitudes de recolección (Rol: HOGAR / RECOLECTOR)',
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindCollectionsQueryDto,
  ) {
    return this.collectionsService.findAll(user, query);
  }

  @Get(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Obtener detalle de una solicitud de recolección por ID (Rol: HOGAR / RECOLECTOR)',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.findOne(id, user.id, user.role);
  }

  @Patch(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Actualizar estado de solicitud (ej. ACCEPTED o COLLECTED)',
  })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCollectionStatusDto,
  ) {
    return this.collectionsService.updateStatus(id, user.id, user.role, dto);
  }

  @Post(':id/verify')
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Verificar entrega física mediante PIN de 4 dígitos del Hogar (Rol: RECOLECTOR)',
  })
  async verifyPin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') collectorId: string,
    @Body() dto: VerifyPinDto,
  ) {
    return this.collectionsService.verifyPin(id, collectorId, dto);
  }
}
