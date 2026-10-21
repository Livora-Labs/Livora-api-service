import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { RedisService } from '../../redis/redis.service';
import { RegisterDto } from '../dto/register.dto';
import { Role } from '@prisma/client';

export interface VerifyOtpResult {
  registerDto: RegisterDto;
  isReviewerBypass: boolean;
}

/**
 * Servicio Especializado de Ciclo de Vida y Seguridad de OTPs en Redis (SRP - PUCP Disoft)
 * Encapsula la generación criptográfica, almacenamiento de hashes (Bcrypt + SHA256),
 * ventanas de expiración (TTL), rate-limiting por cooldown y prevención de fuerza bruta.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Genera un código OTP criptográfico seguro de 6 dígitos, guarda el payload
   * temporal en Redis en esquemas duales y establece TTLs y cooldown.
   */
  async generateAndStoreRegistrationOtp(
    registerDto: RegisterDto,
  ): Promise<string> {
    const code = crypto.randomInt(100000, 999999).toString();
    const otpHash = await bcrypt.hash(code, 10);
    const shaHash = crypto.createHash('sha256').update(code).digest('hex');

    const email = registerDto.email;
    const payloadKey = `auth:register:payload:${email}`;
    const codeKey = `auth:otp:code:${email}`;
    const cooldownKey = `auth:otp:cooldown:${email}`;
    const attemptsKey = `auth:otp:attempts:${email}`;

    // Esquema de compatibilidad dual
    const redisKey = `otp:register:${email}`;
    const payload = {
      registerDto,
      otpHash: shaHash,
      otpExpiresAt: Date.now() + 10 * 60 * 1000,
    };
    await this.redisService.set(redisKey, JSON.stringify(payload), 1800);
    await this.redisService.del(`otp:attempts:${email}`);
    await this.redisService.set(`otp:cooldown:${email}`, '1', 60);

    // Esquema local canónico
    await this.redisService.set(payloadKey, JSON.stringify(registerDto), 1800);
    await this.redisService.set(codeKey, otpHash, 600);
    await this.redisService.del(attemptsKey);
    await this.redisService.set(cooldownKey, '1', 60);

    return code;
  }

  /**
   * Valida el código OTP ingresado contra Redis.
   * Maneja bypass de revisor Play Store, bloqueo tras 5 intentos fallidos
   * y compatibilidad criptográfica dual (Bcrypt / SHA-256).
   */
  async verifyRegistrationOtp(
    email: string,
    code: string,
  ): Promise<VerifyOtpResult> {
    const payloadKey = `auth:register:payload:${email}`;
    const codeKey = `auth:otp:code:${email}`;
    const attemptsKeyLocal = `auth:otp:attempts:${email}`;

    const redisKey = `otp:register:${email}`;
    const attemptsKeyColleague = `otp:attempts:${email}`;

    // 1. Obtener payload temporal de registro desde Redis
    let rawPayload = await this.redisService.get(payloadKey);
    let parsed: any = null;
    let isColleagueKey = false;

    if (rawPayload) {
      parsed = JSON.parse(rawPayload);
    } else {
      rawPayload = await this.redisService.get(redisKey);
      if (rawPayload) {
        parsed = JSON.parse(rawPayload);
        isColleagueKey = true;
      }
    }

    const isReviewerBypass =
      email.toLowerCase() === 'playstore.review@livora.pe' && code === '123456';

    if (!rawPayload && !isReviewerBypass) {
      throw new BadRequestException('El código OTP ha expirado o no existe');
    }

    const registerDto: RegisterDto = parsed
      ? parsed.registerDto || parsed
      : {
          email: 'playstore.review@livora.pe',
          password: 'LivoraReview2026!',
          role: Role.HOGAR,
          termsAccepted: true,
          privacyAccepted: true,
        };

    // 2. Obtener hash del código OTP
    let storedOtpHash = '';
    let otpExpiresAt: number | undefined = undefined;

    if (isColleagueKey) {
      storedOtpHash = parsed.otpHash;
      otpExpiresAt = parsed.otpExpiresAt;
    } else if (rawPayload) {
      storedOtpHash = (await this.redisService.get(codeKey)) || '';
    }

    if (!storedOtpHash && !isReviewerBypass) {
      throw new BadRequestException('El código OTP ha expirado o no existe');
    }

    // 3. Validar límite de 5 intentos fallidos
    const attemptsKey = isColleagueKey ? attemptsKeyColleague : attemptsKeyLocal;
    const attemptsRaw = await this.redisService.get(attemptsKey);
    const attempts = attemptsRaw ? parseInt(attemptsRaw, 10) : 0;
    if (attempts >= 5 && !isReviewerBypass) {
      if (isColleagueKey) {
        await this.redisService.del(redisKey);
        await this.redisService.del(attemptsKey);
      } else {
        await this.redisService.del(codeKey);
      }
      throw new BadRequestException(
        'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
      );
    }

    // 3.5 Expiración del código
    if (
      isColleagueKey &&
      otpExpiresAt &&
      Date.now() > otpExpiresAt &&
      !isReviewerBypass
    ) {
      throw new BadRequestException(
        'El código ha expirado. Solicita un reenvío.',
      );
    }

    // 4. Validar el OTP hasheado
    let isValid = isReviewerBypass;
    if (!isValid) {
      try {
        isValid = await bcrypt.compare(code, storedOtpHash);
      } catch {
        isValid = false;
      }
      const shaHash = crypto.createHash('sha256').update(code).digest('hex');
      if (!isValid && storedOtpHash === shaHash) {
        isValid = true;
      }
    }

    if (!isValid) {
      const newAttempts = await this.redisService.incr(attemptsKey);
      if (isColleagueKey) {
        await this.redisService.expire(attemptsKey, 1800);
      } else {
        const remainingTtl = await this.redisService.ttl(payloadKey);
        if (remainingTtl > 0) {
          await this.redisService.expire(attemptsKey, remainingTtl);
        }
      }

      if (newAttempts >= 5) {
        if (isColleagueKey) {
          await this.redisService.del(redisKey);
        } else {
          await this.redisService.del(codeKey);
        }
        throw new BadRequestException(
          'Demasiados intentos fallidos. El código OTP ha sido bloqueado.',
        );
      }
      throw new BadRequestException('El código de verificación es incorrecto');
    }

    return { registerDto, isReviewerBypass };
  }

  /**
   * Reenvía un nuevo código OTP verificando cooldown de 60s y validez del registro previo.
   */
  async resendRegistrationOtp(email: string): Promise<string> {
    const payloadKeyLocal = `auth:register:payload:${email}`;
    const payloadKeyColleague = `otp:register:${email}`;

    // 1. Validar cooldown de 60s
    const cooldownKeyLocal = `auth:otp:cooldown:${email}`;
    const cooldownKeyColleague = `otp:cooldown:${email}`;
    const hasCooldown =
      (await this.redisService.get(cooldownKeyLocal)) ||
      (await this.redisService.get(cooldownKeyColleague));
    if (hasCooldown) {
      throw new BadRequestException(
        'Debes esperar 60 segundos antes de reenviar otro código',
      );
    }

    // 2. Obtener registro temporal y validar TTL
    let rawPayload = await this.redisService.get(payloadKeyLocal);
    let parsed: any = null;
    let isColleagueKey = false;
    let remainingTtl = 0;

    if (rawPayload) {
      parsed = JSON.parse(rawPayload);
      remainingTtl = await this.redisService.ttl(payloadKeyLocal);
    } else {
      rawPayload = await this.redisService.get(payloadKeyColleague);
      if (rawPayload) {
        parsed = JSON.parse(rawPayload);
        isColleagueKey = true;
        remainingTtl = await this.redisService.ttl(payloadKeyColleague);
      }
    }

    if (!rawPayload || remainingTtl <= 0) {
      throw new BadRequestException(
        'El registro temporal no existe o ha expirado. Por favor regístrate de nuevo.',
      );
    }

    const registerDto: RegisterDto = parsed.registerDto || parsed;

    // 3. Generar nuevo OTP
    const code = crypto.randomInt(100000, 999999).toString();
    const bcryptOtpHash = await bcrypt.hash(code, 10);
    const shaOtpHash = crypto.createHash('sha256').update(code).digest('hex');

    // 4. Actualizar en Redis
    await this.redisService.set(
      `auth:otp:code:${email}`,
      bcryptOtpHash,
      remainingTtl,
    );
    await this.redisService.del(`auth:otp:attempts:${email}`);
    await this.redisService.set(cooldownKeyLocal, '1', 60);

    const colleaguePayload = {
      registerDto,
      otpHash: shaOtpHash,
      otpExpiresAt: Date.now() + 10 * 60 * 1000,
    };
    await this.redisService.set(
      payloadKeyColleague,
      JSON.stringify(colleaguePayload),
      1800,
    );
    await this.redisService.del(`otp:attempts:${email}`);
    await this.redisService.set(cooldownKeyColleague, '1', 60);

    return code;
  }

  /**
   * Limpia todas las claves asociadas al OTP en Redis tras completar el registro exitosamente.
   */
  async clearRegistrationOtp(email: string): Promise<void> {
    const payloadKey = `auth:register:payload:${email}`;
    const codeKey = `auth:otp:code:${email}`;
    const attemptsKeyLocal = `auth:otp:attempts:${email}`;
    const redisKey = `otp:register:${email}`;
    const attemptsKeyColleague = `otp:attempts:${email}`;

    await this.redisService.del(payloadKey);
    await this.redisService.del(codeKey);
    await this.redisService.del(attemptsKeyLocal);
    await this.redisService.del(`auth:otp:cooldown:${email}`);

    await this.redisService.del(redisKey);
    await this.redisService.del(attemptsKeyColleague);
    await this.redisService.del(`otp:cooldown:${email}`);
  }
}
