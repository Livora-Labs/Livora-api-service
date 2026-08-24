import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly supabaseService: SupabaseService,
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

    const supabaseClient = this.supabaseService.getClient();
    const { data, error } = await supabaseClient.auth.getUser(token);

    if (error || !data.user) {
      throw new UnauthorizedException('Token de sesión no válido o expirado');
    }

    const user = await this.usersService.findById(data.user.id);
    if (!user) {
      throw new UnauthorizedException(
        'Usuario autenticado pero sin perfil local en la base de datos',
      );
    }

    if (user.deletedAt !== null || user.isActive === false) {
      throw new UnauthorizedException('Cuenta desactivada o eliminada');
    }

    const { encryptedPrivateKey, ...safeUser } = user;
    request.user = safeUser;

    return true;
  }
}
