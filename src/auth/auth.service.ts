import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly usersService: UsersService,
  ) {}

  async register(registerDto: RegisterDto) {
    const supabaseClient = this.supabaseService.getClient();

    // 1. Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await supabaseClient.auth.admin.createUser({
      email: registerDto.email,
      password: registerDto.password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      throw new BadRequestException(authError?.message || 'Error al registrar usuario en Supabase Auth');
    }

    try {
      // 2. Crear usuario local en PostgreSQL asociando el ID de Supabase y generando billetera Web3
      const user = await this.usersService.create(authData.user.id, registerDto);
      return {
        message: 'Usuario registrado exitosamente',
        user,
      };
    } catch (error) {
      // Rollback: si falla la creación en DB local, deshabilitar/eliminar usuario de Supabase Auth
      await supabaseClient.auth.admin.deleteUser(authData.user.id);
      throw error;
    }
  }

  async login(loginDto: LoginDto) {
    const supabaseClient = this.supabaseService.getClient();

    // Iniciar sesión con Supabase Auth
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: loginDto.email,
      password: loginDto.password,
    });

    if (error || !data.session) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Obtener perfil local para incluir el rol en la respuesta
    const userProfile = await this.usersService.findById(data.user.id);

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
      tokenType: data.session.token_type,
      user: {
        id: data.user.id,
        email: data.user.email,
        role: userProfile?.role,
        walletAddress: userProfile?.walletAddress,
      },
    };
  }
}
