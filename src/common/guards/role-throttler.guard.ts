import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { Role } from '@prisma/client';

@Injectable()
export class RoleThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return req.ips?.length ? req.ips[0] : req.ip || 'anonymous';
  }

  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { context, limit, throttler } = requestProps;
    const req = context.switchToHttp().getRequest();
    const role = req.user?.role;

    // Ajuste dinámico de tasa para el throttler default según el rol del JWT
    if (throttler.name === 'default' && role) {
      let customLimit = limit;
      switch (role) {
        case Role.HOGAR:
          customLimit = 60;
          break;
        case Role.RECOLECTOR:
          customLimit = 120;
          break;
        case Role.CENTRO_ACOPIO:
        case Role.ALMACEN:
          customLimit = 300;
          break;
        case Role.ADMIN:
          customLimit = 500;
          break;
        case Role.EMPRESA_B2B:
        case Role.TIENDA:
          customLimit = 150;
          break;
        default:
          customLimit = limit;
      }

      return super.handleRequest({
        ...requestProps,
        limit: customLimit,
      });
    }

    if (throttler.name === 'web3_transactions') {
      const benchmarkLimit =
        process.env.THROTTLER_WEB3_LIMIT || process.env.THROTTLER_LIMIT;
      if (benchmarkLimit) {
        return super.handleRequest({
          ...requestProps,
          limit: Math.max(limit, Number(benchmarkLimit)),
        });
      }
    }

    return super.handleRequest(requestProps);
  }
}
