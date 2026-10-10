import {
  Body,
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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GamificationService } from './gamification.service';
import { ClaimRewardDto } from './dto/claim-reward.dto';

@ApiTags('Gamification')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('gamification')
export class GamificationController {
  constructor(private readonly gamificationService: GamificationService) {}

  @Get('forest/weekly-state')
  @ApiOperation({
    summary: 'Obtiene el estado del Árbol Semanal y las 6 misiones de Mi Bosque',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado del bosque semanal calculado para el usuario Hogar',
  })
  async getWeeklyForestState(@CurrentUser('id') userId: string) {
    return this.gamificationService.getWeeklyForestState(userId);
  }

  @Post('forest/claim-reward')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reclama la recompensa semanal de tokens LIVO (+0.50 LIVO en Etapa 3 o +1.00 LIVO en Etapa 4)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Recompensa acreditada exitosamente en la cuenta del usuario',
  })
  async claimWeeklyReward(
    @CurrentUser('id') userId: string,
    @Body() dto: ClaimRewardDto,
  ) {
    return this.gamificationService.claimWeeklyReward(userId, dto);
  }
}
