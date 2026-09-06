import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';

export interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  aud?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    const jwtSecret = configService.get<string>('SUPABASE_JWT_SECRET');
    if (!jwtSecret && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'CRITICAL SECURITY ERROR: La variable de entorno SUPABASE_JWT_SECRET es obligatoria y no está configurada.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret || 'test_jwt_secret_in_isolated_unit_tests',
    });
  }

  async validate(payload: SupabaseJwtPayload) {
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException(
        'Usuario no registrado o token no válido',
      );
    }
    const { encryptedPrivateKey, ...safeUser } = user;
    return safeUser;
  }
}
