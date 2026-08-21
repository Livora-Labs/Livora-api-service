import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(SupabaseAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

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
  @ApiOperation({ summary: 'Eliminación segura de cuenta (GDPR compliance)' })
  @ApiResponse({ status: 200, description: 'Cuenta anonimizada y eliminada con éxito' })
  async deleteAccount(@CurrentUser('id') userId: string) {
    await this.usersService.deleteAccountGDPR(userId);
    return { success: true, message: 'Cuenta eliminada y anonimizada de acuerdo con regulaciones GDPR' };
  }
}
