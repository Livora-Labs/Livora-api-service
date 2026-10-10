import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class TokenService {
  private readonly jwtSecret: string;
  private readonly expiresInSeconds = 3600; // 1 hora estándar OWASP

  constructor(private readonly configService: ConfigService) {
    this.jwtSecret =
      this.configService.get<string>('JWT_SECRET') ||
      'livora_production_jwt_super_secret_key_2026_stlr_eco_security';
  }

  generateAccessToken(payload: { sub: string; email: string; role: string }): string {
    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.expiresInSeconds,
    });
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.jwtSecret) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Token de acceso inválido o expirado');
    }
  }

  decodeToken(token: string): JwtPayload | null {
    try {
      return jwt.decode(token) as JwtPayload | null;
    } catch {
      return null;
    }
  }
}
