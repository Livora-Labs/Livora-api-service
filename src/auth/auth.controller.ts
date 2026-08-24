import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { RefreshDto } from './dto/refresh.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @ApiOperation({
    summary: 'Registrar un nuevo usuario (temporal en Redis, envía OTP)',
  })
  @ApiResponse({
    status: 200,
    description: 'Código de verificación enviado al correo electrónico',
  })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
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

  @Throttle({ default: { limit: 5, ttl: 60000 } })
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

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Iniciar sesión y obtener Bearer Token JWT' })
  @ApiResponse({ status: 200, description: 'Login exitoso con Token JWT' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
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
