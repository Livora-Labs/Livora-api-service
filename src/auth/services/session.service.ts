import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';

export interface SessionData {
  userId: string;
  email: string;
  role: string;
  familyId: string;
  createdAt: number;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly refreshTtlSeconds = 30 * 24 * 60 * 60; // 30 días

  constructor(private readonly redisService: RedisService) {}

  async createSession(data: { userId: string; email: string; role: string }): Promise<string> {
    const refreshToken = randomUUID();
    const familyId = randomUUID();

    const session: SessionData = {
      userId: data.userId,
      email: data.email,
      role: data.role,
      familyId,
      createdAt: Date.now(),
    };

    const client = this.redisService.getClient();
    // Guardar sesión del refresh token
    await client.set(
      `session:rt:${refreshToken}`,
      JSON.stringify(session),
      'EX',
      this.refreshTtlSeconds,
    );

    // Rastrear token en la lista de sesiones del usuario
    await client.sadd(`user:sessions:${data.userId}`, refreshToken);
    await client.expire(`user:sessions:${data.userId}`, this.refreshTtlSeconds);

    return refreshToken;
  }

  async rotateSession(oldRefreshToken: string): Promise<{
    newRefreshToken: string;
    session: SessionData;
  }> {
    const client = this.redisService.getClient();
    const raw = await client.get(`session:rt:${oldRefreshToken}`);

    if (!raw) {
      throw new UnauthorizedException('Sesión expirada o refresh token inválido');
    }

    const session: SessionData = JSON.parse(raw);

    // Invalidad token anterior inmediatamente
    await client.del(`session:rt:${oldRefreshToken}`);
    await client.srem(`user:sessions:${session.userId}`, oldRefreshToken);

    // Crear nuevo refresh token manteniendo la familia de sesión
    const newRefreshToken = randomUUID();
    const updatedSession: SessionData = {
      ...session,
      createdAt: Date.now(),
    };

    await client.set(
      `session:rt:${newRefreshToken}`,
      JSON.stringify(updatedSession),
      'EX',
      this.refreshTtlSeconds,
    );
    await client.sadd(`user:sessions:${session.userId}`, newRefreshToken);

    return {
      newRefreshToken,
      session: updatedSession,
    };
  }

  async invalidateSession(refreshToken: string): Promise<void> {
    const client = this.redisService.getClient();
    const raw = await client.get(`session:rt:${refreshToken}`);
    if (raw) {
      try {
        const session: SessionData = JSON.parse(raw);
        await client.srem(`user:sessions:${session.userId}`, refreshToken);
      } catch {
        // ignore
      }
    }
    await client.del(`session:rt:${refreshToken}`);
  }

  async invalidateAllUserSessions(userId: string): Promise<void> {
    const client = this.redisService.getClient();
    const tokens = await client.smembers(`user:sessions:${userId}`);
    if (tokens && tokens.length > 0) {
      const pipeline = client.pipeline();
      for (const token of tokens) {
        pipeline.del(`session:rt:${token}`);
      }
      pipeline.del(`user:sessions:${userId}`);
      await pipeline.exec();
    }
  }
}
