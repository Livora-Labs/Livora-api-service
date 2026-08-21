import { Controller, Get, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Healthcheck general de la API Gateway' })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('debug-sentry')
  @ApiOperation({ summary: 'Endpoint de diagnóstico para probar captura de errores en Sentry' })
  debugSentry() {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException('Cannot GET /debug-sentry');
    }
    throw new Error('Test Sentry Error: Diagnóstico de backend NestJS');
  }
}
