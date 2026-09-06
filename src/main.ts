import './instrument';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RedisIoAdapter } from './websockets/adapters/redis-io.adapter';
import { DecimalTransformInterceptor } from './common/interceptors/decimal-transform.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { CorrelationContext } from './common/context/correlation-context';
import * as crypto from 'crypto';

async function bootstrap() {
  process.env.APP_MODE = process.env.APP_MODE || 'API';
  if (process.env.APP_MODE !== 'API') {
    throw new Error(
      `[Livora API Error] Modo no válido para main.ts: APP_MODE=${process.env.APP_MODE}. Para modo WORKER ejecute main-worker.ts.`,
    );
  }

  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 1048576, // 1MB límite estricto para prevenir DoS por memoria
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
  );

  // Hook Fastify para propagación y trazabilidad distribuida de X-Correlation-ID
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.addHook(
    'onRequest',
    (request: any, reply: any, done: any) => {
      const correlationId =
        (request.headers['x-correlation-id'] as string) ||
        (request.headers['x-request-id'] as string) ||
        crypto.randomUUID();
      request.correlationId = correlationId;
      reply.header('X-Correlation-ID', correlationId);
      CorrelationContext.run(correlationId, () => {
        done();
      });
    },
  );

  // Configuración estricta de cabeceras de seguridad HTTP con Helmet para Fastify
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false, // Permitir Swagger UI
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },
    noSniff: true,
    hidePoweredBy: true,
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

  // Configuración de CORS restrictiva usando ALLOWED_ORIGINS o CORS_ORIGIN
  const corsOrigin =
    configService.get<string>('ALLOWED_ORIGINS') ||
    configService.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim())
      : ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  });

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new DecimalTransformInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => new BadRequestException(errors),
    }),
  );

  const redisIoAdapter = new RedisIoAdapter(app, configService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // --- Configuración de Swagger ---
  const config = new DocumentBuilder()
    .setTitle('Livora API')
    .setDescription(
      'API Gateway y Backend de la plataforma de reciclaje trazable Livora en Stellar/Soroban (Testnet)',
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
    `Livora API Gateway corriendo con Fastify en el puerto: ${port}`,
  );
  console.log(`Swagger UI disponible en: http://localhost:${port}/api/docs`);
}
void bootstrap();
