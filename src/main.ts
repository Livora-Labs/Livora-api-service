import './instrument';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RedisIoAdapter } from './websockets/adapters/redis-io.adapter';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { IpfsGatewayInterceptor } from './common/interceptors/ipfs-gateway.interceptor';

async function bootstrap() {
  const adapter = new FastifyAdapter({
    trustProxy: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
  );

  // Configuración de cabeceras de seguridad HTTP con Helmet para Fastify
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // Permitir Swagger UI
  });

  // Configuración de soporte multipart para subida de fotos / archivos
  await app.register(fastifyMultipart, {
    attachFieldsToBody: 'keyValues',
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
    },
    async onFile(part: any) {
      const buffer = await part.toBuffer();
      (this as any).incomingFile = {
        originalname: part.filename,
        mimetype: part.mimetype,
        buffer,
        size: buffer.length,
      };
    },
  });

  // Habilitar Graceful Shutdown para cerrar conexiones limpiamente
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  // Configuración de CORS restrictiva usando la variable de entorno CORS_ORIGIN
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://localhost:3001'],
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
  console.log(
    `🚀 Livora API Gateway corriendo con Fastify en el puerto: ${port}`,
  );
  console.log(`📚 Swagger UI disponible en: http://localhost:${port}/api/docs`);
}
void bootstrap();
