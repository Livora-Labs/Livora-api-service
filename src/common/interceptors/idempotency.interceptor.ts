import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { RedisService } from '../../redis/redis.service';
import { REQUIRE_IDEMPOTENCY_KEY } from '../decorators/require-idempotency.decorator';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const isHttp = context.getType() === 'http';
    if (!isHttp) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const isExplicitlyRequired = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_IDEMPOTENCY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const idempotencyKey =
      req.headers['idempotency-key'] ||
      req.headers['idempotency_key'] ||
      req.headers['x-idempotency-key'];

    if (isExplicitlyRequired && !idempotencyKey) {
      throw new BadRequestException(
        "Encabezado 'Idempotency-Key' es obligatorio para transacciones financieras o de pesaje",
      );
    }

    if (!idempotencyKey) {
      return next.handle();
    }

    const redisKey = `idempotency:${idempotencyKey}`;

    return from(this.redisService.get(redisKey)).pipe(
      switchMap((cached) => {
        if (cached === 'PROCESSING') {
          throw new ConflictException('Transaction currently being processed');
        }

        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            const statusCode = parsed.statusCode || 200;
            if (typeof res.status === 'function') {
              res.status(statusCode);
            } else if (typeof res.code === 'function') {
              res.code(statusCode);
            }
            this.logger.log(
              `[Idempotencia] Respuesta servida desde caché para clave: ${idempotencyKey}`,
            );
            return of(parsed.body !== undefined ? parsed.body : parsed);
          } catch {
            return of(cached);
          }
        }

        return from(this.redisService.setNX(redisKey, 'PROCESSING', 60)).pipe(
          switchMap((acquired) => {
            if (!acquired) {
              throw new ConflictException(
                'Transaction currently being processed',
              );
            }

            return next.handle().pipe(
              tap({
                next: async (responseBody) => {
                  try {
                    const statusCode =
                      res.statusCode || res.raw?.statusCode || 200;
                    await this.redisService.set(
                      redisKey,
                      JSON.stringify({ statusCode, body: responseBody }),
                      86400, // 24 horas TTL
                    );
                  } catch (err: any) {
                    this.logger.error(
                      `Error al persistir respuesta idempotente: ${err.message}`,
                    );
                  }
                },
                error: async () => {
                  try {
                    await this.redisService.del(redisKey);
                  } catch (err: any) {
                    this.logger.error(
                      `Error al liberar clave de idempotencia: ${err.message}`,
                    );
                  }
                },
              }),
            );
          }),
        );
      }),
    );
  }
}
