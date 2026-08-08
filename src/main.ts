import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RedisIoAdapter } from './websockets/adapters/redis-io.adapter';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { IpfsGatewayInterceptor } from './common/interceptors/ipfs-gateway.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Allow all origins in development; in production accept the FRONTEND_URL env var
  const frontendUrl = process.env.FRONTEND_URL;
  app.enableCors({
    origin: frontendUrl ? [frontendUrl, 'http://localhost:3001'] : true,
    credentials: true,
  });

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const configService = app.get(ConfigService);
  app.useGlobalInterceptors(new IpfsGatewayInterceptor(configService));

  const redisIoAdapter = new RedisIoAdapter(app, configService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // --- Configuración de Swagger ---
  const config = new DocumentBuilder()
    .setTitle('Livora API')
    .setDescription(
      'API Gateway y Backend de la plataforma de reciclaje trazable Livora en Arbitrum Sepolia',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Render requires listening on 0.0.0.0
  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Livora API Gateway corriendo en el puerto: ${port}`);
  console.log(`📚 Swagger UI disponible en: http://localhost:${port}/api/docs`);
}
bootstrap();

