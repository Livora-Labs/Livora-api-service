import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(SupabaseAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado (rol y wallet)' })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  async getMe(@CurrentUser('id') userId: string) {
    const u = await this.usersService.findById(userId);
    if (!u) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      walletAddress: u.walletAddress,
      createdAt: u.createdAt,
    };
  }

  @Patch('fcm-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar token de notificaciones FCM' })
  @ApiResponse({ status: 200, description: 'Token FCM actualizado con éxito' })
  async updateFcmToken(
    @CurrentUser('id') userId: string,
    @Body('fcmToken') fcmToken: string,
  ) {
    await this.usersService.updateFcmToken(userId, fcmToken);
    return { success: true, message: 'Token FCM actualizado' };
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Eliminación segura de cuenta y anonimización ARCO (Ley 29733 / GDPR)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Cuenta anonimizada y eliminada con éxito conforme a la Ley 29733',
  })
  async deleteAccount(@CurrentUser('id') userId: string) {
    return this.usersService.cancelAccountARCO(userId);
  }
}
