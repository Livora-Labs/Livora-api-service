import { Injectable, Optional } from '@nestjs/common';
import { User, ConsentAudit } from '@prisma/client';
import { IUsersRepository } from '../repositories/users.repository.interface';
import { UsersRepository } from '../repositories/users.repository';
import { RedisService } from '../../redis/redis.service';

/**
 * Patrón Proxy de Caché (PUCP Disoft Diapositiva 13-15)
 * Controla el acceso al objeto de servicio original (UsersRepository) interceptando
 * consultas frecuentes para resolverlas en memoria o Redis antes de golpear la base de datos.
 */
@Injectable()
export class UserCacheProxy implements IUsersRepository {
  private readonly memoryCache = new Map<string, { user: User; expires: number }>();
  private readonly DEFAULT_TTL_MS = 10000; // 10 segundos

  constructor(
    private readonly realRepository: UsersRepository,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async findById(id: string): Promise<User | null> {
    const now = Date.now();
    const inMemory = this.memoryCache.get(id);
    if (inMemory && inMemory.expires > now) {
      return inMemory.user;
    }

    if (this.redisService) {
      try {
        const cached = await this.redisService.get(`user:cache:${id}`);
        if (cached) {
          const user: User = JSON.parse(cached);
          this.memoryCache.set(id, { user, expires: now + this.DEFAULT_TTL_MS });
          return user;
        }
      } catch {
        // Fallback transparente al repositorio real ante indisponibilidad de Redis
      }
    }

    // Delegación al objeto de servicio real (PUCP Disoft Slide 14)
    const user = await this.realRepository.findById(id);

    if (user) {
      this.memoryCache.set(id, { user, expires: now + this.DEFAULT_TTL_MS });
      if (this.memoryCache.size > 2000) {
        for (const [k, v] of this.memoryCache.entries()) {
          if (v.expires <= now) this.memoryCache.delete(k);
        }
      }

      if (this.redisService) {
        this.redisService
          .set(`user:cache:${id}`, JSON.stringify(user), 30)
          .catch(() => {});
      }
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    // Lectura directa al repositorio para asegurar consistencia estricta en auth
    return this.realRepository.findByEmail(email);
  }

  async create(data: any): Promise<User> {
    return this.realRepository.create(data);
  }

  async update(id: string, data: any): Promise<User> {
    this.evictCache(id);
    return this.realRepository.update(id, data);
  }

  async updateFcmToken(id: string, fcmToken: string): Promise<User> {
    this.evictCache(id);
    return this.realRepository.updateFcmToken(id, fcmToken);
  }

  async getConsentAudits(userId: string): Promise<ConsentAudit[]> {
    return this.realRepository.getConsentAudits(userId);
  }

  /**
   * Invalida la entrada de caché cuando la entidad es modificada (Cache Invalidation)
   */
  public evictCache(id: string): void {
    this.memoryCache.delete(id);
    if (this.redisService) {
      this.redisService.del(`user:cache:${id}`).catch(() => {});
    }
  }
}
