import { Module, Global } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PasswordService } from './services/password.service';
import { TokenService } from './services/token.service';
import { SessionService } from './services/session.service';
import { OtpService } from './services/otp.service';

@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    OtpService,
    JwtStrategy,
  ],
  exports: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    OtpService,
    JwtStrategy,
    PassportModule,
  ],
})
export class AuthModule {}
