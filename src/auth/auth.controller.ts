import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshDto } from './dto/refresh.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({
    summary: 'Registrar un nuevo usuario (temporal en Redis, envía OTP)',
  })
  @ApiResponse({
    status: 200,
    description: 'Código de verificación enviado al correo electrónico',
  })
  async register(@Body() registerDto: RegisterDto, @Req() req?: any) {
    const rawIp = req?.ip || req?.headers?.['x-forwarded-for'] || '127.0.0.1';
    const ipAddress = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';
    const userAgent = req?.headers?.['user-agent'] || 'unknown';

    // Eliminar ipAddress y userAgent recibidos del cliente para evitar manipulación
    const { ipAddress: _, userAgent: __, ...cleanedDto } = registerDto;

    return this.authService.register({
      ...cleanedDto,
      ipAddress,
      userAgent,
    });
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  @ApiOperation({
    summary: 'Verificar correo electrónico con OTP y crear cuenta definitiva',
  })
  @ApiResponse({
    status: 200,
    description: 'Cuenta creada y sesión iniciada exitosamente con Token JWT',
  })
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    return this.authService.verifyEmail(verifyEmailDto);
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  @ApiOperation({
    summary: 'Reenviar el código de verificación respetando cooldown de 60s',
  })
  @ApiResponse({
    status: 200,
    description: 'Código de verificación reenviado exitosamente',
  })
  async resendOtp(@Body() resendOtpDto: ResendOtpDto) {
    return this.authService.resendOtp(resendOtpDto);
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Iniciar sesión y obtener Bearer Token JWT' })
  @ApiResponse({ status: 200, description: 'Login exitoso con Token JWT' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  @ApiOperation({ summary: 'Solicitar enlace de recuperación de contraseña' })
  @ApiResponse({ status: 200, description: 'Enlace enviado al correo' })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    return this.authService.forgotPassword(forgotPasswordDto);
  }

  @Throttle({ auth_strict: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  @ApiOperation({ summary: 'Restablecer contraseña usando el token' })
  @ApiResponse({ status: 200, description: 'Contraseña actualizada correctamente' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    return this.authService.resetPassword(resetPasswordDto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({
    summary: 'Renovar la sesión con el refresh token (nuevo accessToken)',
  })
  @ApiResponse({
    status: 200,
    description: 'Nueva sesión emitida con accessToken/refreshToken',
  })
  async refresh(@Body() refreshDto: RefreshDto) {
    return this.authService.refresh(refreshDto);
  }
}
