import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { SubmitBidDto } from './dto/submit-bid.dto';
import { SelectBidDto } from './dto/select-bid.dto';
import { AvailableCollectionsQueryDto } from './dto/available-collections-query.dto';
import { RateCollectionDto } from './dto/rate-collection.dto';
import { EditCollectionRequestDto } from './dto/edit-collection-request.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IpfsTransform } from '../common/decorators/ipfs-transform.decorator';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  email?: string;
}

@ApiTags('Collections')
@ApiBearerAuth()
@IpfsTransform()
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
            assignmentMode: (fields.assignmentMode?.value as any) ?? payloadDto?.assignmentMode,
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
  @Roles(Role.HOGAR, Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Listar solicitudes de recolección',
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FindCollectionsQueryDto,
  ) {
    return this.collectionsService.findAll(user, query);
  }

  @Get('available')
  @Roles(Role.RECOLECTOR, Role.ADMIN)
  @ApiOperation({
    summary:
      'Buscar solicitudes de recolección disponibles en radar GPS con filtrado avanzado por Acopio y lotes activos (Rol: RECOLECTOR)',
  })
  async findAvailable(
    @CurrentUser('id') collectorId: string,
    @Query() query: AvailableCollectionsQueryDto,
  ) {
    return this.collectionsService.findAvailable(collectorId, query);
  }

  @Get(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Obtener detalle de una solicitud de recolección por ID',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.findOne(id, user.id, user.role);
  }

  @Post(':id/bids')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Enviar propuesta/postulación de tarifas a una solicitud en subasta (Rol: CENTRO_ACOPIO)',
  })
  async submitBid(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') centerId: string,
    @Body() dto: SubmitBidDto,
  ) {
    return this.collectionsService.submitBid(centerId, id, dto);
  }

  @Delete(':id/bids/:bidId')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Retirar propuesta de subasta antes de ser seleccionada (Rol: CENTRO_ACOPIO)',
  })
  async withdrawBid(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('bidId', ParseUUIDPipe) bidId: string,
    @CurrentUser('id') centerId: string,
  ) {
    return this.collectionsService.withdrawBid(centerId, id, bidId);
  }

  @Post(':id/select-bid')
  @Roles(Role.HOGAR)
  @ApiOperation({
    summary: 'Hogar selecciona la propuesta de un Centro de Acopio en modo Subasta (Rol: HOGAR)',
  })
  async selectBid(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') householdId: string,
    @Body() dto: SelectBidDto,
  ) {
    return this.collectionsService.selectBid(householdId, id, dto);
  }

  @Post(':id/claim-automatic')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Centro de Acopio toma directamente una solicitud en modo Automático (Rol: CENTRO_ACOPIO)',
  })
  async claimAutomatic(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') centerId: string,
  ) {
    return this.collectionsService.claimAutomatic(centerId, id);
  }

  @Post(':id/rate')
  @Roles(Role.HOGAR)
  @ApiOperation({
    summary:
      'Calificar servicio de recolección completado de 1 a 5 estrellas y feedback (Rol: HOGAR)',
  })
  async rateCollection(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') householdId: string,
    @Body() dto: RateCollectionDto,
  ) {
    return this.collectionsService.rateCollectionRequest(householdId, id, dto);
  }

  @Patch(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Actualizar solicitud: edición parcial de materiales (HOGAR en PENDING) o actualización de estado',
  })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: any,
  ) {
    if (
      user.role === Role.HOGAR &&
      (body.itemsEstimated !== undefined || (body.description !== undefined && body.status === undefined))
    ) {
      return this.collectionsService.editCollectionRequest(user.id, id, body);
    }
    return this.collectionsService.updateStatus(id, user.id, user.role, body);
  }

  async updateRequest(
    id: string,
    user: AuthenticatedUser,
    body: any,
  ) {
    return this.updateStatus(id, user, body);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Aceptar solicitud de recolección y bloquear Escrow (Rol: RECOLECTOR)',
  })
  async acceptRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.updateStatus(id, user.id, user.role, {
      status: 'ACCEPTED' as any,
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({
    summary: 'Cancelar solicitud de recolección en estado PENDING',
  })
  async cancelRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collectionsService.updateStatus(id, user.id, user.role, {
      status: 'CANCELLED' as any,
    });
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Abandonar recolección aceptada por contingencia operativa y retornar a PENDING (Rol: RECOLECTOR)',
  })
  async abandonRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') collectorId: string,
    @Body('reason') reason?: string,
  ) {
    return this.collectionsService.abandonCollectionRequest(id, collectorId, reason);
  }

  @Post(':id/verify')
  @Roles(Role.RECOLECTOR)
  @ApiOperation({
    summary:
      'Verificar entrega física mediante PIN de 4 dígitos y liquidar tokens con peso real (Rol: RECOLECTOR)',
  })
  async verifyPin(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') collectorId: string,
    @Body() dto: VerifyPinDto,
  ) {
    return this.collectionsService.verifyPin(id, collectorId, dto);
  }
}

