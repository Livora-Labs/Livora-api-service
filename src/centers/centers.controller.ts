import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CentersService } from './centers.service';
import { UpdatePriceListDto } from './dto/update-price-list.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Centers')
@ApiBearerAuth()
@Controller('centers')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class CentersController {
  constructor(private readonly centersService: CentersService) {}

  @Post('me/prices')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Registrar o actualizar tarifario por material (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  @ApiResponse({
    status: 200,
    description: 'Tarifario actualizado exitosamente',
  })
  async updatePriceList(
    @CurrentUser('id') centerId: string,
    @Body() dto: UpdatePriceListDto,
  ) {
    return this.centersService.updatePriceList(centerId, dto.prices);
  }

  @Get('prices/all')
  @Roles(Role.HOGAR, Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Listar tarifarios vigentes de todos los centros de acopio',
  })
  async getAllPriceLists() {
    return this.centersService.getAllPriceLists();
  }

  @Get(':id/prices')
  @Roles(Role.HOGAR, Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Consultar tarifario por kg de un centro de acopio específico',
  })
  async getPriceList(@Param('id', ParseUUIDPipe) id: string) {
    return this.centersService.getPriceList(id);
  }

  @Get('me/reception-pin')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Obtener PIN de recepción actual (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  @ApiResponse({
    status: 200,
    description: 'PIN de recepción devuelto exitosamente',
  })
  async getReceptionPin(@CurrentUser('id') centerId: string) {
    return this.centersService.getReceptionPin(centerId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('me/reception-pin/refresh')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary: 'Regenerar nuevo PIN de recepción (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  @ApiResponse({
    status: 200,
    description: 'Nuevo PIN de recepción generado y actualizado',
  })
  async refreshReceptionPin(@CurrentUser('id') centerId: string) {
    return this.centersService.refreshReceptionPin(centerId);
  }

  @Get('nearby')
  @Roles(Role.HOGAR, Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary: 'Buscar centros de acopio cercanos por coordenadas GPS (PostGIS GiST)',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de centros cercanos ordenada por distancia',
  })
  async findNearby(
    @CurrentUser('id') _userId: string,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('radius') radius?: string,
  ) {
    const latitude = parseFloat(lat || '-12.0464');
    const longitude = parseFloat(lng || '-77.0428');
    const radiusKm = parseFloat(radius || '10');
    return this.centersService.findNearby(latitude, longitude, radiusKm);
  }

  @Get()
  @Roles(Role.RECOLECTOR, Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Listar todos los Centros (Rol: RECOLECTOR / CENTRO_ACOPIO / ALMACEN / ADMIN)',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de centros devuelta exitosamente',
  })
  async findAll() {
    return this.centersService.findAll();
  }
}

