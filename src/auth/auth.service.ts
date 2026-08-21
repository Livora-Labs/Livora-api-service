import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly usersService: UsersService,
    private readonly redisService: RedisService,
    private readonly mailService: MailService,
  ) {}

  async register(registerDto: RegisterDto) {
    // 1. Verificar si el correo ya existe localmente
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado',
      );
    }

    // 2. Generar código OTP criptográfico seguro de 6 dígitos
    const code = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(code).digest('hex');

    // 3. Guardar en Redis con TTL de 10 minutos (600s)
    const redisKey = `otp:register:${registerDto.email}`;
    const payload = {
      registerDto,
      otpHash,
    };
    await this.redisService.set(redisKey, JSON.stringify(payload), 600);

    // 4. Configurar cooldown de reenvío de 60s
    const cooldownKey = `otp:cooldown:${registerDto.email}`;
    await this.redisService.set(cooldownKey, '1', 60);

    // 5. Enviar correo electrónico
    await this.mailService.sendOtpEmail(registerDto.email, code);

    return {
      message: 'Código de verificación enviado al correo electrónico',
      email: registerDto.email,
    };
  }

  async verifyEmail(verifyEmailDto: VerifyEmailDto) {
    const { email, code } = verifyEmailDto;
    const redisKey = `otp:register:${email}`;

    // 1. Obtener payload temporal desde Redis
    const rawData = await this.redisService.get(redisKey);
    if (!rawData) {
      throw new BadRequestException('El código OTP ha expirado o no existe');
    }

    const { registerDto, otpHash } = JSON.parse(rawData) as {
      registerDto: RegisterDto;
      otpHash: string;
    };

    // 2. Validar el OTP hasheado
    const inputHash = crypto.createHash('sha256').update(code).digest('hex');
    if (inputHash !== otpHash) {
      throw new BadRequestException('El código de verificación es incorrecto');
    }

    // 3. Crear usuario en Supabase Auth
    const supabaseClient = this.supabaseService.getClient();
    const { data: authData, error: authError } =
      await supabaseClient.auth.admin.createUser({
        email: registerDto.email,
        password: registerDto.password,
        email_confirm: true,
      });

    if (authError || !authData.user) {
      throw new BadRequestException(
        authError?.message || 'Error al registrar usuario en Supabase Auth',
      );
    }

    let user;
    try {
      // 4. Crear registro en PostgreSQL (genera wallet y la cifra)
      user = await this.usersService.create(authData.user.id, registerDto);
    } catch (error) {
      // Rollback: si falla creación en base de datos local, eliminar usuario en Supabase Auth
      await supabaseClient.auth.admin.deleteUser(authData.user.id);
      throw error;
    }

    // 5. Iniciar sesión y emitir JWT automáticamente
    const { data: loginData, error: loginError } =
      await supabaseClient.auth.signInWithPassword({
        email: registerDto.email,
        password: registerDto.password,
      });

    if (loginError || !loginData.session) {
      throw new UnauthorizedException('Error al iniciar sesión tras verificación');
    }

    // 6. Limpiar OTP en Redis
    await this.redisService.del(redisKey);
    await this.redisService.del(`otp:cooldown:${email}`);

    return {
      accessToken: loginData.session.access_token,
      refreshToken: loginData.session.refresh_token,
      expiresIn: loginData.session.expires_in,
      tokenType: loginData.session.token_type,
      user: {
        id: loginData.user.id,
        email: loginData.user.email,
        role: user.role,
        walletAddress: user.walletAddress,
      },
    };
  }

  async resendOtp(resendOtpDto: ResendOtpDto) {
    const { email } = resendOtpDto;

    // 1. Validar cooldown
    const cooldownKey = `otp:cooldown:${email}`;
    const hasCooldown = await this.redisService.get(cooldownKey);
    if (hasCooldown) {
      throw new BadRequestException(
        'Debes esperar 60 segundos antes de reenviar otro código',
      );
    }

    // 2. Obtener registro temporal desde Redis
    const redisKey = `otp:register:${email}`;
    const rawData = await this.redisService.get(redisKey);
    if (!rawData) {
      throw new BadRequestException(
        'El registro temporal no existe o ha expirado. Por favor regístrate de nuevo.',
      );
    }

    const { registerDto } = JSON.parse(rawData) as { registerDto: RegisterDto };

    // 3. Generar nuevo OTP
    const code = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(code).digest('hex');

    // 4. Actualizar en Redis manteniendo la misma expiración de 10 min
    const payload = {
      registerDto,
      otpHash,
    };
    await this.redisService.set(redisKey, JSON.stringify(payload), 600);

    // 5. Configurar cooldown de reenvío de 60s
    await this.redisService.set(cooldownKey, '1', 60);

    // 6. Enviar nuevo correo
    await this.mailService.sendOtpEmail(email, code);

    return {
      message: 'Código de verificación reenviado exitosamente',
      email,
    };
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
