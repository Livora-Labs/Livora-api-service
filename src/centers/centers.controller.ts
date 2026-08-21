import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
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
