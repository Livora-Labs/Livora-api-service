import { Controller, Get, InternalServerErrorException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BlockchainService } from '../blockchain/services/blockchain.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly blockchain: BlockchainService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Verificar estado de salud de los servicios integrados',
  })
  @ApiResponse({ status: 200, description: 'Servicios en óptimas condiciones' })
  @ApiResponse({ status: 500, description: 'Uno o más servicios caídos' })
  async check() {
    const status = {
      database: 'UP',
      redis: 'UP',
      blockchainRpc: 'UP',
    };
    let isHealthy = true;

    // 1. PostgreSQL check
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      status.database = 'DOWN';
      isHealthy = false;
    }

    // 2. Redis check
    try {
      const ping = await this.redis.ping();
      if (ping !== 'PONG') {
        status.redis = 'DOWN';
        isHealthy = false;
      }
    } catch (err) {
      status.redis = 'DOWN';
      isHealthy = false;
    }

    // 3. Blockchain RPC check
    try {
      const isConnected = await this.blockchain.checkConnection();
      if (!isConnected) {
        status.blockchainRpc = 'DOWN';
        isHealthy = false;
      }
    } catch (err) {
      status.blockchainRpc = 'DOWN';
      isHealthy = false;
    }

    if (!isHealthy) {
      throw new InternalServerErrorException({
        status: 'error',
        details: status,
      });
    }

    return {
      status: 'ok',
      details: status,
    };
  }
}
