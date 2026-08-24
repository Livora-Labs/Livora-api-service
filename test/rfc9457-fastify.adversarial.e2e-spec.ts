import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Module,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IsEmail, IsNotEmpty, IsNumber, Min } from 'class-validator';
import request from 'supertest';
import {
  GlobalExceptionFilter,
  ProblemDetails,
} from '../src/common/filters/global-exception.filter';
import type { FastifyRequest } from 'fastify';

class TestDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  @IsNotEmpty({ message: 'email is required' })
  email!: string;

  @IsNumber({}, { message: 'amount must be a number' })
  @Min(1, { message: 'amount must be at least 1' })
  amount!: number;
}

@Controller('test-adversarial')
class TestAdversarialController {
  @Get('success')
  getSuccess() {
    return { ok: true };
  }

  @Get('bad-request-string')
  getBadRequestString() {
    throw new BadRequestException(
      'El identificador proporcionado no es válido',
    );
  }

  @Post('validation')
  postValidation(@Body() dto: TestDto) {
    return { success: true, email: dto.email };
  }

  @Get('unauthorized')
  getUnauthorized() {
    throw new UnauthorizedException('Token de autenticación expirado');
  }

  @Get('forbidden')
  getForbidden() {
    throw new ForbiddenException('Acceso denegado al recurso');
  }

  @Get('not-found')
  getNotFound() {
    throw new NotFoundException('Colección de reciclaje no encontrada');
  }

  @Get('conflict')
  getConflict() {
    throw new ConflictException('La dirección de billetera ya está en uso');
  }

  @Get('custom-error')
  getCustomError() {
    throw new HttpException(
      {
        error: 'STELLAR_INSUFFICIENT_FEE',
        title: 'Insufficient Stellar Fee',
        message: 'El saldo del Relayer no cubre la tarifa mínima de la red',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  @Get('unhandled-throw')
  getUnhandledThrow() {
    throw new Error('Database pool connection timeout on node-primary');
  }

  @Get('ip-check')
  getIpCheck(@Req() req: FastifyRequest) {
    return { ip: req.ip, ips: req.ips };
  }
}

@Module({
  controllers: [TestAdversarialController],
})
class TestAdversarialModule {}

describe('RFC 9457 & Fastify Engine Adversarial E2E Tests', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAdversarialModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );

    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('1. GET /test-adversarial/success returns 200 OK', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/success')
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it('2. GET /test-adversarial/bad-request-string returns RFC 9457 400 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/bad-request-string')
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/bad_request',
      title: 'Bad Request',
      status: 400,
      detail: 'El identificador proporcionado no es válido',
      instance: '/test-adversarial/bad-request-string',
    });
  });

  it('3. POST /test-adversarial/validation with invalid payload returns RFC 9457 400 with invalid_params breakdown', async () => {
    const res = await request(app.getHttpServer())
      .post('/test-adversarial/validation')
      .send({ email: 'not-an-email', amount: -5, extraField: 'hacker' })
      .expect(400);

    const body = res.body as ProblemDetails;
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.type).toBe('https://api.livora.org/errors/bad_request');
    expect(body.title).toBe('Bad Request');
    expect(body.status).toBe(400);
    expect(body.detail).toBe(
      'Error de validación en los parámetros de entrada',
    );
    expect(body.instance).toBe('/test-adversarial/validation');
    expect(Array.isArray(body.invalid_params)).toBe(true);

    const paramNames = (body.invalid_params || []).map(
      (p: { name: string; reason: string }) => p.name,
    );
    expect(paramNames).toContain('email');
    expect(paramNames).toContain('amount');
    expect(paramNames).toContain('property');
  });

  it('4. GET /test-adversarial/unauthorized returns RFC 9457 401 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/unauthorized')
      .expect(401);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Token de autenticación expirado',
      instance: '/test-adversarial/unauthorized',
    });
  });

  it('5. GET /test-adversarial/forbidden returns RFC 9457 403 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/forbidden')
      .expect(403);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'Acceso denegado al recurso',
      instance: '/test-adversarial/forbidden',
    });
  });

  it('6. GET /test-adversarial/not-found returns RFC 9457 404 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/not-found')
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/not_found',
      title: 'Not Found',
      status: 404,
      detail: 'Colección de reciclaje no encontrada',
      instance: '/test-adversarial/not-found',
    });
  });

  it('7. GET /test-adversarial/conflict returns RFC 9457 409 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/conflict')
      .expect(409);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'La dirección de billetera ya está en uso',
      instance: '/test-adversarial/conflict',
    });
  });

  it('8. GET /test-adversarial/custom-error returns custom RFC 9457 error code and title', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/custom-error')
      .expect(402);

    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toEqual({
      type: 'https://api.livora.org/errors/stellar_insufficient_fee',
      title: 'Insufficient Stellar Fee',
      status: 402,
      detail: 'El saldo del Relayer no cubre la tarifa mínima de la red',
      instance: '/test-adversarial/custom-error',
    });
  });

  it('9. GET /test-adversarial/unhandled-throw returns RFC 9457 500 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/unhandled-throw')
      .expect(500);

    const body = res.body as ProblemDetails;
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.type).toBe(
      'https://api.livora.org/errors/internal_server_error',
    );
    expect(body.title).toBe('Internal Server Error');
    expect(body.status).toBe(500);
    expect(body.instance).toBe('/test-adversarial/unhandled-throw');
  });

  it('10. GET /non-existent-route returns RFC 9457 404 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .get('/non-existent-route')
      .expect(404);

    const body = res.body as ProblemDetails;
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.status).toBe(404);
    expect(body.type).toBe('https://api.livora.org/errors/not_found');
    expect(body.title).toBe('Not Found');
    expect(body.instance).toBe('/non-existent-route');
  });

  it('11. POST /test-adversarial/validation with malformed JSON body returns 400 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .post('/test-adversarial/validation')
      .set('Content-Type', 'application/json')
      .send('{ "broken_json": ')
      .expect(400);

    const body = res.body as ProblemDetails;
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.status).toBe(400);
    expect(body.title).toBe('Bad Request');
  });

  it('12. Fastify trustProxy correctly resolves X-Forwarded-For header', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-adversarial/ip-check')
      .set('X-Forwarded-For', '203.0.113.195, 198.51.100.1')
      .expect(200);

    const body = res.body as { ip: string; ips: string[] };
    expect(body.ip).toBe('203.0.113.195');
  });
});
