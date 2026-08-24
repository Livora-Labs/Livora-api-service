import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly usersService: UsersService,
    private readonly redisService: RedisService,
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
  ) {}

  async register(registerDto: RegisterDto) {
    // 1. Verificar si el correo ya existe localmente
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado',
      );
    }

    // 2. Generar código OTP criptográfico seguro de 6 dígitos y hash con bcrypt
    const code = crypto.randomInt(100000, 999999).toString();
    const otpHash = await bcrypt.hash(code, 10);

    const payloadKey = `auth:register:payload:${registerDto.email}`;
    const codeKey = `auth:otp:code:${registerDto.email}`;
    const cooldownKey = `auth:otp:cooldown:${registerDto.email}`;
    const attemptsKey = `auth:otp:attempts:${registerDto.email}`;

    // 3. Guardar payload de registro con TTL inmutable de 10 minutos (600s)
    await this.redisService.set(payloadKey, JSON.stringify(registerDto), 600);

    // 4. Guardar hash de código OTP con TTL de 600s
    await this.redisService.set(codeKey, otpHash, 600);

    // 5. Reiniciar intentos previos
    await this.redisService.del(attemptsKey);

    // 6. Configurar cooldown de reenvío de 60s
    await this.redisService.set(cooldownKey, '1', 60);

    // 7. Enviar correo electrónico
    await this.mailService.sendOtpEmail(registerDto.email, code);

    return {
      message: 'Código de verificación enviado al correo electrónico',
      email: registerDto.email,
    };
  }

  async verifyEmail(verifyEmailDto: VerifyEmailDto) {
    const { email, code } = verifyEmailDto;
    const payloadKey = `auth:register:payload:${email}`;
    const codeKey = `auth:otp:code:${email}`;
    const cooldownKey = `auth:otp:cooldown:${email}`;
    const attemptsKey = `auth:otp:attempts:${email}`;

    // 1. Obtener payload temporal de registro desde Redis
    const rawPayload = await this.redisService.get(payloadKey);
    if (!rawPayload) {
      throw new BadRequestException('El código OTP ha expirado o no existe');
    }

    const parsed = JSON.parse(rawPayload);
    const registerDto: RegisterDto = parsed.registerDto || parsed;

    // 2. Obtener hash del código OTP desde Redis
    const storedOtpHash = await this.redisService.get(codeKey);
    if (!storedOtpHash) {
      throw new BadRequestException('El código OTP ha expirado o no existe');
    }

    // 3. Validar límite de 5 intentos fallidos
    const attemptsRaw = await this.redisService.get(attemptsKey);
    const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;
    if (attempts >= 5) {
      throw new BadRequestException(
        'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
      );
    }

    // 4. Validar el OTP hasheado (bcrypt compare o fallback sha256)
    let isValid = false;
    try {
      isValid = await bcrypt.compare(code, storedOtpHash);
    } catch {
      isValid = false;
    }
    if (
      !isValid &&
      storedOtpHash === crypto.createHash('sha256').update(code).digest('hex')
    ) {
      isValid = true;
    }

    if (!isValid) {
      const newAttempts = await this.redisService.incr(attemptsKey);
      const remainingTtl = await this.redisService.ttl(payloadKey);
      if (remainingTtl > 0) {
        await this.redisService.expire(attemptsKey, remainingTtl);
      }
      if (newAttempts >= 5) {
        await this.redisService.del(codeKey);
        throw new BadRequestException(
          'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
        );
      }
      throw new BadRequestException('El código de verificación es incorrecto');
    }

    // 5. Crear usuario en Supabase Auth
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
      // 6. Crear registro en PostgreSQL (genera wallet y la cifra)
      user = await this.usersService.create(authData.user.id, registerDto);

      // 7. Registrar consentimiento inmutable de acuerdo con la Ley 29733 (ConsentAudit)
      const termsVersion = registerDto.termsVersion || '1.0.0';
      const privacyVersion = registerDto.privacyVersion || '1.0.0';
      const marketingAccepted = registerDto.marketingAccepted ?? false;
      const documentHash =
        registerDto.documentHash ||
        crypto
          .createHash('sha256')
          .update(`Livora-Terms-${termsVersion}-Privacy-${privacyVersion}`)
          .digest('hex');
      const ipAddress = registerDto.ipAddress || '127.0.0.1';
      const userAgent = registerDto.userAgent || 'unknown';

      await this.prisma.consentAudit.create({
        data: {
          userId: user.id,
          ipAddress,
          userAgent,
          termsVersion,
          privacyVersion,
          marketingAccepted,
          documentHash,
          consentedAt: new Date(),
        },
      });
    } catch (error) {
      // Rollback: si falla creación en base de datos local, eliminar usuario en Supabase Auth
      await supabaseClient.auth.admin.deleteUser(authData.user.id);
      throw error;
    }

    // 7. Iniciar sesión y emitir JWT automáticamente
    const { data: loginData, error: loginError } =
      await supabaseClient.auth.signInWithPassword({
        email: registerDto.email,
        password: registerDto.password,
      });

    if (loginError || !loginData.session) {
      throw new UnauthorizedException(
        'Error al iniciar sesión tras verificación',
      );
    }

    // 8. Limpiar todas las claves asociadas en Redis
    await this.redisService.del(payloadKey);
    await this.redisService.del(codeKey);
    await this.redisService.del(attemptsKey);
    await this.redisService.del(cooldownKey);

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

  async verifyOtp(verifyEmailDto: VerifyEmailDto) {
    return this.verifyEmail(verifyEmailDto);
  }

  async resendOtp(resendOtpDto: ResendOtpDto) {
    const { email } = resendOtpDto;
    const payloadKey = `auth:register:payload:${email}`;
    const codeKey = `auth:otp:code:${email}`;
    const cooldownKey = `auth:otp:cooldown:${email}`;
    const attemptsKey = `auth:otp:attempts:${email}`;

    // 1. Validar cooldown de 60s
    const hasCooldown = await this.redisService.get(cooldownKey);
    if (hasCooldown) {
      throw new BadRequestException(
        'Debes esperar 60 segundos antes de reenviar otro código',
      );
    }

    // 2. Obtener registro temporal desde Redis y validar TTL
    const remainingTtl = await this.redisService.ttl(payloadKey);
    const rawPayload = await this.redisService.get(payloadKey);
    if (!rawPayload || remainingTtl <= 0) {
      throw new BadRequestException(
        'El registro temporal no existe o ha expirado. Por favor regístrate de nuevo.',
      );
    }

    // 3. Generar nuevo OTP y hash con bcrypt
    const code = crypto.randomInt(100000, 999999).toString();
    const otpHash = await bcrypt.hash(code, 10);

    // 4. Guardar nuevo hash en Redis con TTL clampado al TTL restante del payload (sin reiniciar payload)
    await this.redisService.set(codeKey, otpHash, remainingTtl);

    // 5. Reiniciar intentos fallidos para el nuevo código
    await this.redisService.del(attemptsKey);

    // 6. Configurar cooldown de reenvío de 60s
    await this.redisService.set(cooldownKey, '1', 60);

    // 7. Enviar nuevo correo
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

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    const { email } = forgotPasswordDto;

    // 1. Verificar si el usuario existe localmente
    const existingUser = await this.usersService.findByEmail(email);
    if (!existingUser) {
      throw new BadRequestException(
        'El correo electrónico no se encuentra registrado',
      );
    }

    // 2. Generar token criptográfico único
    const token = crypto.randomBytes(32).toString('hex');
    const tokenKey = `auth:password-reset:token:${token}`;

    // 3. Guardar token en Redis con TTL de 1 hora (3600 segundos)
    await this.redisService.set(tokenKey, email, 3600);

    // 4. Generar enlace de restablecimiento
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3002';
    const resetLink = `${frontendUrl}/restablecer-contrasena?token=${token}`;

    // 5. Enviar el correo electrónico
    await this.mailService.sendPasswordRecoveryEmail(email, resetLink);

    return {
      message: 'Enlace de recuperación enviado exitosamente al correo electrónico',
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    const { token, password } = resetPasswordDto;
    const tokenKey = `auth:password-reset:token:${token}`;

    // 1. Obtener correo asociado al token en Redis
    const email = await this.redisService.get(tokenKey);
    if (!email) {
      throw new BadRequestException(
        'El enlace de recuperación es inválido o ha expirado',
      );
    }

    // 2. Obtener usuario localmente
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new BadRequestException(
        'No se pudo encontrar el usuario asociado a este token',
      );
    }

    // 3. Actualizar contraseña en Supabase Auth usando la API admin
    const supabaseClient = this.supabaseService.getClient();
    const { error } = await supabaseClient.auth.admin.updateUserById(user.id, {
      password: password,
    });

    if (error) {
      throw new BadRequestException(
        error.message || 'Error al restablecer la contraseña en Supabase',
      );
    }

    // 4. Eliminar el token de Redis para evitar reuso
    await this.redisService.del(tokenKey);

    return {
      message: 'Contraseña restablecida exitosamente',
    };
  }
}
