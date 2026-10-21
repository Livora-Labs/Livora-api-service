import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MailService } from '../common/services/mail.service';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { SessionService } from './services/session.service';
import { OtpService } from './services/otp.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RefreshDto } from './dto/refresh.dto';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  private readonly otpService: OtpService;

  constructor(
    private readonly usersService: UsersService,
    private readonly redisService: RedisService,
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    @Optional() otpService?: OtpService,
  ) {
    this.otpService = otpService ?? new OtpService(this.redisService);
  }

  async register(registerDto: RegisterDto) {
    // 0. Prohibir autoregistro público del rol ADMINISTRADOR
    if (registerDto.role === Role.ADMIN) {
      throw new ForbiddenException(
        'El rol ADMINISTRADOR no admite autoregistro público',
      );
    }

    // 1. Verificar si el correo ya existe localmente
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado',
      );
    }

    // 2. Generar código OTP y persistir en Redis delegando en OtpService
    const code = await this.otpService.generateAndStoreRegistrationOtp(registerDto);

    // 3. Enviar correo electrónico
    await this.mailService.sendOtpEmail(registerDto.email, code);

    return {
      message: 'Código de verificación enviado al correo electrónico',
      email: registerDto.email,
    };
  }

  async verifyEmail(verifyEmailDto: VerifyEmailDto) {
    const { email, code } = verifyEmailDto;

    // 1. Validar OTP en Redis mediante OtpService
    const { registerDto } = await this.otpService.verifyRegistrationOtp(
      email,
      code,
    );

    // 2. Generar UUID criptográfico para el usuario
    const userId = crypto.randomUUID();

    // 3. Hashear la contraseña con Bcrypt (12 rondas OWASP)
    const passwordHash = await this.passwordService.hash(registerDto.password);

    // 4. Crear usuario y credenciales en PostgreSQL
    const user = await this.usersService.create(userId, registerDto, passwordHash);

    // 5. Registrar auditoría de consentimiento legal (Ley 29733)
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

    // 6. Emitir JWT de acceso y Refresh Token rotativo en Redis
    const accessToken = this.tokenService.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = await this.sessionService.createSession({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    // 7. Limpiar claves asociadas en Redis mediante OtpService
    await this.otpService.clearRegistrationOtp(email);

    return {
      accessToken,
      refreshToken,
      expiresIn: 3600,
      tokenType: 'bearer',
      user: {
        id: user.id,
        email: user.email,
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

    // 1. Delegar validación de cooldown y regeneración en OtpService
    const code = await this.otpService.resendRegistrationOtp(email);

    // 2. Enviar nuevo correo
    await this.mailService.sendOtpEmail(email, code);

    return {
      message: 'Código de verificación reenviado exitosamente',
      email,
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { credentials: true },
    });

    if (!user || !user.isActive || user.deletedAt !== null) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!user.credentials) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Verificar si la cuenta se encuentra bloqueada por intentos fallidos
    if (user.credentials.lockedUntil && user.credentials.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.credentials.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException(
        `Cuenta bloqueada temporalmente por demasiados intentos fallidos. Intenta nuevamente en ${minutesLeft} minutos.`,
      );
    }

    // Comparar contraseña con Bcrypt
    const isMatch = await this.passwordService.compare(
      loginDto.password,
      user.credentials.passwordHash,
    );

    if (!isMatch) {
      const failedAttempts = user.credentials.failedAttempts + 1;
      const updateData: any = { failedAttempts };
      if (failedAttempts >= 5) {
        updateData.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // Bloqueo por 15 min
      }
      await this.prisma.userCredential.update({
        where: { userId: user.id },
        data: updateData,
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Restablecer intentos fallidos tras inicio exitoso
    if (user.credentials.failedAttempts > 0 || user.credentials.lockedUntil !== null) {
      await this.prisma.userCredential.update({
        where: { userId: user.id },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    }

    // Generar Access Token (1h) y Refresh Token (30 días en Redis)
    const accessToken = this.tokenService.generateAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = await this.sessionService.createSession({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 3600,
      tokenType: 'bearer',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        walletAddress: user.walletAddress,
        kycStatus: user.kycStatus || 'UNVERIFIED',
      },
    };
  }

  private getFrontendUrl(): string {
    const configuredUrl = process.env.FRONTEND_URL?.trim();
    const isProd = process.env.NODE_ENV === 'production';

    if (configuredUrl) {
      if (isProd && configuredUrl.includes('localhost')) {
        const domain = process.env.DOMAIN?.trim() || 'grupolivoralabs.com';
        return `https://${domain}`;
      }
      return configuredUrl.replace(/\/+$/, '');
    }

    if (process.env.DOMAIN?.trim()) {
      return `https://${process.env.DOMAIN.trim()}`;
    }

    if (isProd) {
      return 'https://grupolivoralabs.com';
    }

    return 'http://localhost:3000';
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

    // 4. Generar enlace de restablecimiento con URL canónica segura
    const frontendUrl = this.getFrontendUrl();
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

    // 3. Actualizar contraseña hasheada en PostgreSQL
    const passwordHash = await this.passwordService.hash(password);
    await this.prisma.userCredential.upsert({
      where: { userId: user.id },
      update: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastPasswordChange: new Date(),
      },
      create: {
        userId: user.id,
        passwordHash,
        lastPasswordChange: new Date(),
      },
    });

    // 4. Invalidar todas las sesiones activas en Redis por seguridad
    await this.sessionService.invalidateAllUserSessions(user.id);

    // 5. Eliminar el token de Redis para evitar reuso
    await this.redisService.del(tokenKey);

    return {
      message: 'Contraseña restablecida exitosamente',
    };
  }

  async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
    const { currentPassword, newPassword } = changePasswordDto;

    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'La nueva contraseña debe ser diferente a la contraseña actual',
      );
    }

    // 1. Obtener usuario con credenciales
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { credentials: true },
    });
    if (!user || !user.isActive || user.deletedAt) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (!user.credentials) {
      throw new BadRequestException('El usuario no posee credenciales registradas');
    }

    // 2. Verificar la contraseña actual
    const isMatch = await this.passwordService.compare(
      currentPassword,
      user.credentials.passwordHash,
    );
    if (!isMatch) {
      throw new BadRequestException('La contraseña actual es incorrecta');
    }

    // 3. Actualizar contraseña hasheada
    const passwordHash = await this.passwordService.hash(newPassword);
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
        lastPasswordChange: new Date(),
      },
    });

    // 4. Invalidar sesiones anteriores
    await this.sessionService.invalidateAllUserSessions(userId);

    return {
      message: 'Contraseña actualizada exitosamente',
    };
  }

  async refresh(refreshDto: RefreshDto) {
    // 1. Rotar sesión y validar Token Reuse Detection
    const { newRefreshToken, session } = await this.sessionService.rotateSession(
      refreshDto.refreshToken,
    );

    // 2. Obtener perfil local actualizado
    const userProfile = await this.usersService.findById(session.userId);
    if (!userProfile || !userProfile.isActive || userProfile.deletedAt) {
      throw new UnauthorizedException('Usuario no válido o suspendido');
    }

    // 3. Emitir nuevo Access Token
    const accessToken = this.tokenService.generateAccessToken({
      sub: session.userId,
      email: session.email,
      role: session.role,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: 3600,
      tokenType: 'bearer',
      user: {
        id: session.userId,
        email: session.email,
        role: userProfile.role,
        walletAddress: userProfile.walletAddress,
        kycStatus: userProfile.kycStatus || 'UNVERIFIED',
      },
    };
  }
}
