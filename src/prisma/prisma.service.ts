import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';

function buildPoolConfig(
  dbUrl: string,
  isWorker: boolean,
  isReadReplica = false,
): PoolConfig {
  const defaultMax = isWorker ? 5 : isReadReplica ? 10 : 10;
  const maxConnections =
    parseInt(process.env.DB_POOL_MAX || '', 10) || defaultMax;

  const isPgBouncer = dbUrl.includes('pgbouncer=true');

  return {
    connectionString: dbUrl,
    max: maxConnections,
    idleTimeoutMillis: isPgBouncer ? 10000 : 30000,
    connectionTimeoutMillis: 5000,
    allowExitOnIdle: true,
  };
}

function createPrismaAdapter(
  url?: string,
  isReadReplica = false,
): { adapter: PrismaPg; pool?: Pool } {
  const dbUrl =
    url ||
    (isReadReplica
      ? process.env.READ_REPLICA_DATABASE_URL || process.env.DATABASE_URL
      : process.env.DATABASE_URL);

  const isWorker = process.env.APP_MODE === 'WORKER';

  if (dbUrl) {
    const poolConfig = buildPoolConfig(dbUrl, isWorker, isReadReplica);
    const pool = new Pool(poolConfig);
    const adapter = new PrismaPg(pool);
    return { adapter, pool };
  }
  return { adapter: new PrismaPg({ connectionString: '' }) };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private pool?: Pool;
  private readPool?: Pool;
  public readonly read: PrismaClient;

  constructor() {
    const primary = createPrismaAdapter(undefined, false);
    super({ adapter: primary.adapter });
    this.pool = primary.pool;

    const replica = createPrismaAdapter(undefined, true);
    this.readPool = replica.pool;
    this.read = new PrismaClient({ adapter: replica.adapter });
  }

  getReadClient(): PrismaClient {
    return this.read;
  }

  async onModuleInit() {
    await this.$connect();
    if (this.read && typeof this.read.$connect === 'function') {
      try {
        await this.read.$connect();
      } catch (err: any) {
        this.logger.warn(
          `No se pudo conectar a la réplica de lectura: ${err.message}.`,
        );
      }
    }
    this.logger.log(
      `PrismaService conectado a PostgreSQL (modo: ${process.env.APP_MODE || 'HYBRID'}) con soporte PgBouncer y Read Replicas`,
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.read && typeof this.read.$disconnect === 'function') {
      await this.read.$disconnect();
    }
    if (this.pool) {
      await this.pool.end();
    }
    if (this.readPool) {
      await this.readPool.end();
    }
  }
}
