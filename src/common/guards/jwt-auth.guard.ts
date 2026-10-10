import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../auth/services/token.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException(
        'Token de autorización no encontrado en la cabecera',
      );
    }

    // Limpieza defensiva por si se envía "Bearer Bearer <token>" o "Bearer <token>"
    let token = authHeader.trim();
    while (/^bearer(\s+|$)/i.test(token)) {
      token = token.replace(/^bearer(\s+|$)/i, '').trim();
      if (!token) break;
    }

    if (!token) {
      throw new UnauthorizedException('Token JWT no especificado');
    }

    // Verificación criptográfica local en memoria (0.05 ms de latencia)
    let payload;
    try {
      payload = this.tokenService.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Token de sesión no válido o expirado');
    }

    const userId = payload.sub;
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException(
        'Usuario autenticado pero sin perfil local en la base de datos',
      );
    }

    if (user.deletedAt !== null || user.isActive === false) {
      throw new UnauthorizedException('Cuenta desactivada o eliminada');
    }

    const { encryptedPrivateKey, encryptionIv, encryptionTag, ...safeUser } = user as any;
    request.user = safeUser;
    return true;
  }
}
