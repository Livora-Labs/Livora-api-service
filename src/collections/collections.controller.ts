import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { FindCollectionsQueryDto } from './dto/find-collections-query.dto';
import { UpdateCollectionStatusDto } from './dto/update-collection-status.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Collections')
@ApiBearerAuth()
@Controller('collection-requests')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Post()
  @Roles(Role.HOGAR)
  @ApiOperation({ summary: 'Crear solicitud de recolección (Rol: HOGAR)' })
  @UseInterceptors(FileInterceptor('photo'))
  async create(
    @CurrentUser() user: any,
    @Body() dto: CreateCollectionDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.collectionsService.create(user.id, dto, file);
  }

  @Get()
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({ summary: 'Listar solicitudes de recolección (Rol: HOGAR / RECOLECTOR)' })
  async findAll(
    @CurrentUser() user: any,
    @Query() query: FindCollectionsQueryDto,
  ) {
    return this.collectionsService.findAll(user, query);
  }

  @Get(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({ summary: 'Obtener detalle de una solicitud de recolección por ID (Rol: HOGAR / RECOLECTOR)' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.collectionsService.findOne(id, user.id, user.role);
  }

  @Patch(':id')
  @Roles(Role.HOGAR, Role.RECOLECTOR)
  @ApiOperation({ summary: 'Actualizar estado de solicitud (ej. ACCEPTED o COLLECTED)' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateCollectionStatusDto,
  ) {
    return this.collectionsService.updateStatus(id, user.id, user.role, dto);
  }
}

