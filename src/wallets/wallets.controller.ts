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
import { Throttle } from '@nestjs/throttler';
import { WalletsService } from './wallets.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Wallets')
@ApiBearerAuth()
@Controller('wallets')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get('me/balance')
  @ApiOperation({
    summary: 'Consultar saldo de EcoTokens (SEP-41) en Stellar/Soroban',
  })
  @ApiResponse({ status: 200, description: 'Saldo devuelto exitosamente' })
  async getBalance(@CurrentUser('id') userId: string) {
    return this.walletsService.getBalance(userId);
  }

  @Throttle({ web3_transactions: { limit: 10, ttl: 60000 } })
  @Post('transactions')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Realizar transferencia de EcoTokens con Gas Subsidiado por Relayer (HTTP 202)',
  })
  @ApiResponse({
    status: 202,
    description:
      'Transacción procesada por el Relayer y enviada a la blockchain',
  })
  async sendTransaction(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.walletsService.sendTransaction(userId, dto);
  }

  @Get('transactions/history')
  @ApiOperation({
    summary:
      'Consultar historial de transacciones (recompensas y canjes) del usuario',
  })
  @ApiResponse({ status: 200, description: 'Historial retornado exitosamente' })
  async getTransactionHistory(@CurrentUser('id') userId: string) {
    return this.walletsService.getTransactionHistory(userId);
  }
}
