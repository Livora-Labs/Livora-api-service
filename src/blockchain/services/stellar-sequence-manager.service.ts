import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { RedisService } from '../../redis/redis.service';
import { randomBytes } from 'crypto';

@Injectable()
export class StellarSequenceManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarSequenceManager.name);

  // Pool de cuentas de canal (Channel Accounts) disponibles para firmas concurrentes
  private channelPool: Keypair[] = [];
  private inUseChannels = new Set<string>();

  // Clave maestra del Relayer
  private primaryWorkerKeypair: Keypair;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    this.initKeys();
  }

  onModuleDestroy() {
    this.channelPool = [];
    this.inUseChannels.clear();
  }

  private initKeys() {
    const workerSecretKey = this.configService.get<string>('WORKER_SECRET_KEY');
    if (workerSecretKey && workerSecretKey !== 'S...') {
      try {
        this.primaryWorkerKeypair = Keypair.fromSecret(workerSecretKey);
        this.logger.log(
          `Stellar Primary Worker inicializado: ${this.primaryWorkerKeypair.publicKey()}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Clave WORKER_SECRET_KEY inválida: ${err.message}. Usando keypair aleatorio.`,
        );
        this.primaryWorkerKeypair = Keypair.random();
      }
    } else {
      this.primaryWorkerKeypair = Keypair.random();
    }

    // Inicializar pool de Channel Accounts desde STELLAR_CHANNEL_SECRET_KEYS
    const channelKeysConfig = this.configService.get<string>(
      'STELLAR_CHANNEL_SECRET_KEYS',
    );
    this.channelPool = [];
    this.inUseChannels.clear();

    if (channelKeysConfig) {
      const keys = channelKeysConfig
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.startsWith('S') && k.length === 56);

      for (const secret of keys) {
        try {
          const kp = Keypair.fromSecret(secret);
          this.channelPool.push(kp);
        } catch (e: any) {
          this.logger.warn(
            `Error al parsear Channel Keypair: ${e.message}`,
          );
        }
      }
      this.logger.log(
        `Stellar Channel Accounts Pool inicializado con ${this.channelPool.length} canales.`,
      );
    }

    // Si no se configuraron canales externos, incluir la cuenta primaria en el pool base
    if (this.channelPool.length === 0) {
      this.channelPool.push(this.primaryWorkerKeypair);
      this.logger.log(
        'No se configuraron STELLAR_CHANNEL_SECRET_KEYS adicionales. Usando primary worker keypair con Distributed Mutex.',
      );
    }
  }

  /**
   * Obtiene la clave primaria configurada para el worker relayer.
   */
  getPrimaryWorkerKeypair(): Keypair {
    return this.primaryWorkerKeypair;
  }

  /**
   * Obtiene el tamaño total del pool de canales.
   */
  getPoolSize(): number {
    return this.channelPool.length;
  }

  /**
   * Arrienda (lease) un Keypair del pool de canales para ejecutar una transacción aislada.
   * Si todos los canales están ocupados, espera hasta que uno se libere (o agota timeout).
   */
  async acquireChannelAccount(timeoutMs = 15000): Promise<Keypair> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      for (const keypair of this.channelPool) {
        const pub = keypair.publicKey();
        if (!this.inUseChannels.has(pub)) {
          this.inUseChannels.add(pub);
          return keypair;
        }
      }
      // Esperar 100ms antes de volver a verificar disponibilidad de canales
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Fallback: retornar primary worker keypair
    this.logger.warn(
      'Timeout esperando un canal disponible en el pool. Retornando primary worker keypair.',
    );
    return this.primaryWorkerKeypair;
  }

  /**
   * Libera un Keypair de canal arrendado, poniéndolo nuevamente a disposición del pool.
   */
  releaseChannelAccount(keypair: Keypair): void {
    if (keypair) {
      this.inUseChannels.delete(keypair.publicKey());
    }
  }

  /**
   * Ejecuta una función transaccional arrendando un canal del pool y liberándolo automáticamente.
   */
  async withChannelAccount<T>(
    fn: (keypair: Keypair) => Promise<T>,
    timeoutMs = 15000,
  ): Promise<T> {
    const keypair = await this.acquireChannelAccount(timeoutMs);
    try {
      // Si el pool solo tiene 1 cuenta (la primaria), aplicamos lock distribuido por seguridad de secuencia
      if (this.channelPool.length <= 1) {
        return await this.withAccountLock(
          keypair.publicKey(),
          () => fn(keypair),
          timeoutMs,
        );
      }
      return await fn(keypair);
    } finally {
      this.releaseChannelAccount(keypair);
    }
  }

  /**
   * Ejecuta una operación asegurando un Lock Mutex Atómico en Redis para una cuenta específica de Stellar.
   * Previene colisiones de sequenceNumber (tx_bad_seq) cuando múltiples hilos/workers intentan firmar
   * con la misma clave pública al mismo tiempo.
   */
  async withAccountLock<T>(
    publicKey: string,
    fn: () => Promise<T>,
    ttlMs = 15000,
  ): Promise<T> {
    const lockKey = `stellar:lock:seq:${publicKey}`;
    const lockVal = randomBytes(16).toString('hex');
    const client = this.redisService ? this.redisService.getClient() : null;

    let acquired = false;
    const startTime = Date.now();

    if (client) {
      while (Date.now() - startTime < ttlMs) {
        try {
          const res = await client.set(lockKey, lockVal, 'PX', ttlMs, 'NX');
          if (res === 'OK') {
            acquired = true;
            break;
          }
        } catch (e: any) {
          this.logger.warn(
            `Error al intentar adquirir lock en Redis para ${publicKey}: ${e.message}`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    try {
      return await fn();
    } finally {
      if (acquired && client) {
        // Liberar el lock atómicamente con Lua Script si el valor sigue siendo nuestro
        const luaScript = `
          if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
          else
            return 0
          end
        `;
        try {
          await client.eval(luaScript, 1, lockKey, lockVal);
        } catch (err: any) {
          this.logger.warn(
            `Error al liberar lock de Redis para ${publicKey}: ${err.message}`,
          );
        }
      }
    }
  }
}
