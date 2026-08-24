import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Module,
  Post,
  Body,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { CreateCollectionDto } from '../src/collections/dto/create-collection.dto';
import {
  GlobalExceptionFilter,
  ProblemDetails,
} from '../src/common/filters/global-exception.filter';
import request from 'supertest';

@Controller('test-challenger')
class TestChallengerController {
  @Get('hello')
  getHello() {
    return { message: 'ok' };
  }

  @Post('collect')
  create(@Body() dto: CreateCollectionDto, @Req() req: any) {
    return {
      dto,
      file: req.incomingFile
        ? {
            name: req.incomingFile.originalname,
            size: req.incomingFile.size,
            mimetype: req.incomingFile.mimetype,
          }
        : null,
    };
  }
}

@Module({
  controllers: [TestChallengerController],
})
class TestChallengerModule {}

describe('Challenger M1 Iteration 2 Empirical Verification Suite', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const adapter = new FastifyAdapter({ trustProxy: true });
    app = await NestFactory.create<NestFastifyApplication>(
      TestChallengerModule,
      adapter,
    );

    await app.register(fastifyHelmet, { contentSecurityPolicy: false });
    await app.register(fastifyMultipart, {
      attachFieldsToBody: 'keyValues',
      limits: { fileSize: 10 * 1024 * 1024 },
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

    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    const config = new DocumentBuilder()
      .setTitle('Livora API')
      .setDescription('Empirical Challenger Verification API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('1. @fastify/static & SwaggerModule Initialization', () => {
    it('serves Swagger UI HTML at /api/docs/ with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs/')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('swagger-ui');
    });

    it('serves Swagger OpenAPI JSON spec at /api/docs-json with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.openapi || res.body.swagger).toBeDefined();
      expect(res.body.info.title).toBe('Livora API');
    });

    it('serves Swagger static assets (e.g. swagger-ui.css) via @fastify/static', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs/swagger-ui.css')
        .expect(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.text.length).toBeGreaterThan(0);
    });
  });

  describe('2. Fastify Multipart & ValidationPipe Integration', () => {
    it('accepts multipart/form-data with file and stringified JSON itemsEstimated', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-challenger/collect')
        .field('itemsEstimated', JSON.stringify({ PET: 3.5, GLASS: 1.2 }))
        .field('latitude', '-12.0464')
        .field('longitude', '-77.0428')
        .field('description', 'Recyclables outside')
        .attach('file', Buffer.from('test-image-binary-payload'), 'bolsa.png')
        .expect(201);

      expect(res.body.dto.itemsEstimated).toEqual({ PET: 3.5, GLASS: 1.2 });
      expect(res.body.dto.latitude).toBe(-12.0464);
      expect(res.body.dto.longitude).toBe(-77.0428);
      expect(res.body.dto.description).toBe('Recyclables outside');
      expect(res.body.file).toEqual({
        name: 'bolsa.png',
        size: Buffer.from('test-image-binary-payload').length,
        mimetype: 'image/png',
      });
    });

    it('accepts pure JSON application/json payload without multipart', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-challenger/collect')
        .send({
          itemsEstimated: { PLASTIC: 4.5, CARDBOARD: 2.0 },
          latitude: -12.0464,
          longitude: -77.0428,
          description: 'JSON request only',
        })
        .expect(201);

      expect(res.body.dto.itemsEstimated).toEqual({
        PLASTIC: 4.5,
        CARDBOARD: 2.0,
      });
      expect(res.body.dto.latitude).toBe(-12.0464);
      expect(res.body.dto.longitude).toBe(-77.0428);
      expect(res.body.file).toBeNull();
    });

    it('rejects multipart request with unwhitelisted extra field (forbidNonWhitelisted test)', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-challenger/collect')
        .field('itemsEstimated', JSON.stringify({ PET: 1.0 }))
        .field('latitude', '-12.0464')
        .field('longitude', '-77.0428')
        .field('unrecognizedInjectedField', 'malicious')
        .expect(400);

      const body = res.body as ProblemDetails;
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(body.status).toBe(400);
      expect(body.type).toBe('https://api.livora.org/errors/bad_request');
      expect(Array.isArray(body.invalid_params)).toBe(true);
      const invalidParamNames = (body.invalid_params || []).map((p) => p.name);
      expect(invalidParamNames).toContain('property');
    });

    it('rejects multipart request with invalid coordinates outside boundary [-90, 90]', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-challenger/collect')
        .field('itemsEstimated', JSON.stringify({ PET: 1.0 }))
        .field('latitude', '125.45')
        .field('longitude', '-77.0428')
        .expect(400);

      const body = res.body as ProblemDetails;
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(body.status).toBe(400);
      expect(body.type).toBe('https://api.livora.org/errors/bad_request');
      expect(Array.isArray(body.invalid_params)).toBe(true);
      const invalidParamNames = (body.invalid_params || []).map((p) => p.name);
      expect(invalidParamNames).toContain('latitude');
    });

    it('rejects multipart request with invalid itemsEstimated non-JSON string', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-challenger/collect')
        .field('itemsEstimated', 'not-a-valid-json-string')
        .field('latitude', '-12.0464')
        .field('longitude', '-77.0428')
        .expect(400);

      const body = res.body as ProblemDetails;
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(body.status).toBe(400);
      expect(body.type).toBe('https://api.livora.org/errors/bad_request');
      expect(Array.isArray(body.invalid_params)).toBe(true);
      const invalidParamNames = (body.invalid_params || []).map((p) => p.name);
      expect(invalidParamNames).toContain('itemsEstimated');
    });
  });

  describe('3. RFC 9457 Global Error Format Compliance', () => {
    it('returns RFC 9457 Problem Details structure on 404', async () => {
      const res = await request(app.getHttpServer())
        .get('/non-existing-challenger-path')
        .expect(404);

      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toEqual(
        expect.objectContaining({
          type: 'https://api.livora.org/errors/not_found',
          title: 'Not Found',
          status: 404,
          instance: '/non-existing-challenger-path',
        }),
      );
    });
  });
});
