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
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(SupabaseAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil completo del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil del usuario' })
  async getMe(@CurrentUser('id') userId: string) {
    const u = await this.usersService.findById(userId);
    if (!u) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const audits = await this.usersService.getConsentAudits(userId);
    const lastAudit = audits[0] || null;

    return {
      id: u.id,
      email: u.email,
      role: u.role,
      walletAddress: u.walletAddress,
      createdAt: u.createdAt,
      name: u.name,
      phone: u.phone,
      address: u.address,
      latitude: u.latitude,
      longitude: u.longitude,
      marketingAccepted: u.marketingAccepted,
      termsVersion: lastAudit?.termsVersion || '2.0.0',
      privacyVersion: lastAudit?.privacyVersion || '2.0.0',
    };
  }

  @Get('me/dashboard')
  @ApiOperation({ summary: 'Métricas, wallet y solicitud activa para el inicio' })
  @ApiResponse({ status: 200, description: 'Datos consolidados para el dashboard' })
  async getDashboard(@CurrentUser('id') userId: string) {
    return this.usersService.getDashboard(userId);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar campos del perfil del usuario' })
  @ApiResponse({ status: 200, description: 'Perfil actualizado con éxito' })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    await this.usersService.update(userId, dto);
    return { success: true, message: 'Perfil actualizado con éxito' };
  }

  @Patch('me/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar contraseña con validación de complejidad' })
  @ApiResponse({ status: 200, description: 'Contraseña cambiada con éxito' })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(userId, dto.newPassword);
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
