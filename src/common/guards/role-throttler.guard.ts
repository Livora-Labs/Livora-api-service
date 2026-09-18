import {
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerRequest,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { UsersService } from '../../users/users.service';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class RoleThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(RoleThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Optional()
    private readonly usersService?: UsersService,
  ) {
    super(options, storageService, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    await this.resolveUserFromAuthHeader(req);
    return super.canActivate(context);
  }

  private async resolveUserFromAuthHeader(req: any): Promise<void> {
    if (req.user) {
      return;
    }

    const authHeader = req.headers?.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      return;
    }

    let token = authHeader.trim();
    while (/^bearer(\s+|$)/i.test(token)) {
      token = token.replace(/^bearer(\s+|$)/i, '').trim();
      if (!token) break;
    }

    if (!token) {
      return;
    }

    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
      return;
    }

    try {
      const decoded = jwt.verify(token, jwtSecret) as {
        sub?: string;
        role?: string;
        user_metadata?: { role?: Role };
      };

      if (!decoded?.sub) {
        return;
      }

      if (this.usersService) {
        const dbUser = await this.usersService.findById(decoded.sub);
        if (dbUser && dbUser.deletedAt === null && dbUser.isActive !== false) {
          const { encryptedPrivateKey, ...safeUser } = dbUser;
          req.user = safeUser;
        }
      } else {
        req.user = {
          id: decoded.sub,
          role: decoded.user_metadata?.role || decoded.role || Role.HOGAR,
        };
      }
    } catch {
      // Token inválido o expirado se delega al guardia de autenticación
    }
  }

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
