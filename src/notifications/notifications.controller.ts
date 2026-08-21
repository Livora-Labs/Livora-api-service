import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Obtener notificaciones del usuario autenticado paginadas',
  })
  @ApiResponse({ status: 200, description: 'Lista paginada de notificaciones' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.notificationsService.findAll(userId, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Marcar notificación como leída/no leída' })
  @ApiResponse({
    status: 200,
    description: 'Notificación actualizada exitosamente',
  })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateNotificationDto,
  ) {
    return this.notificationsService.updateStatus(id, userId, dto);
  }
}
