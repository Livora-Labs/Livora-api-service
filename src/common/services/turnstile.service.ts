import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secretKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.secretKey = this.configService.get<string>('TURNSTILE_SECRET_KEY');
  }

  /**
   * Valida un token emitido por el widget Cloudflare Turnstile del frontend.
   */
  async verifyToken(token?: string, remoteIp?: string): Promise<boolean> {
    if (!this.secretKey) {
      this.logger.debug('TURNSTILE_SECRET_KEY no configurada; omitiendo validación.');
      return true;
    }

    // En entornos de testing o si se envía token especial de prueba
    if (token === 'XXXX.DUMMY.TOKEN.XXXX') {
      return true;
    }

    if (!token) {
      // Si está configurada la clave en producción, requerir token
      if (process.env.NODE_ENV === 'production') {
        throw new BadRequestException('Falta la verificación de seguridad Cloudflare Turnstile');
      }
      return true;
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', this.secretKey);
      formData.append('response', token);
      if (remoteIp) {
        formData.append('remoteip', remoteIp);
      }

      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
      });

      const outcome = (await res.json()) as { success: boolean; 'error-codes'?: string[] };

      if (!outcome.success) {
        this.logger.warn(`Validación Cloudflare Turnstile fallida: ${JSON.stringify(outcome['error-codes'])}`);
        throw new BadRequestException('La verificación de seguridad Cloudflare Turnstile no es válida o ha expirado');
      }

      return true;
    } catch (err: unknown) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error en llamada a Cloudflare Turnstile API: ${msg}`);
      return true;
    }
  }
}
