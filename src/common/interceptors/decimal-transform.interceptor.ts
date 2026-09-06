import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Prisma } from '@prisma/client';

/**
 * DecimalTransformInterceptor
 * Transforma recursivamente todas las instancias de Prisma.Decimal a 'number'
 * en las respuestas JSON para mantener 100% de compatibilidad con
 * los modelos Dart (double / num) en livora-app-movil.
 */
@Injectable()
export class DecimalTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.transformDecimal(data)));
  }

  private transformDecimal(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }

    if (Prisma.Decimal.isDecimal(value)) {
      return value.toNumber();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.transformDecimal(item));
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
      const transformed: Record<string, any> = {};
      for (const key of Object.keys(value)) {
        transformed[key] = this.transformDecimal(value[key]);
      }
      return transformed;
    }

    return value;
  }
}
