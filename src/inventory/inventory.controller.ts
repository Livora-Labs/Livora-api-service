import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { CreateMovementDto } from './dto/create-movement.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('inventory')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN, Role.ADMIN)
  @ApiOperation({
    summary:
      'Consultar el inventario de materiales (Rol: CENTRO_ACOPIO / ALMACEN / ADMIN)',
  })
  async getInventory(@CurrentUser() user: any) {
    const centerId = user.role === Role.ADMIN ? undefined : user.id;
    return this.inventoryService.getInventory(centerId);
  }

  @Post('inventory/movements')
  @Roles(Role.CENTRO_ACOPIO, Role.ALMACEN)
  @ApiOperation({
    summary:
      'Registrar movimiento de entrada/salida de inventario (Rol: CENTRO_ACOPIO / ALMACEN)',
  })
  async createMovement(
    @CurrentUser('id') centerId: string,
    @Body() dto: CreateMovementDto,
  ) {
    return this.inventoryService.createMovement(centerId, dto);
  }
}
