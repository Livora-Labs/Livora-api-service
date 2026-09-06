import * as dotenv from 'dotenv';
dotenv.config();

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Role } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { BlockchainService } from '../../src/blockchain/services/blockchain.service';
import { StellarRpcManagerService } from '../../src/blockchain/services/stellar-rpc-manager.service';
import { UsersService } from '../../src/users/users.service';
import * as crypto from 'crypto';

jest.setTimeout(45000);

describe('Lifecycle E2E: Full Operational & Web3 Lifecycle Flow', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  // Mock users
  const householdId = '11111111-1111-4111-a111-111111111111';
  const collectorId = '22222222-2222-4222-a222-222222222222';
  const centerUserId = '33333333-3333-4333-a333-333333333333';
  const storeUserId = '44444444-4444-4444-a444-444444444444';

  const mockUsers: Record<string, any> = {
    [householdId]: {
      id: householdId,
      email: 'hogar@livora.pe',
      name: 'Hogar E2E',
      role: Role.HOGAR,
      isActive: true,
      deletedAt: null,
      publicKey: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    },
    [collectorId]: {
      id: collectorId,
      email: 'recolector@livora.pe',
      name: 'Recolector E2E',
      role: Role.RECOLECTOR,
      isActive: true,
      deletedAt: null,
      publicKey: 'GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    },
    [centerUserId]: {
      id: centerUserId,
      email: 'centro@livora.pe',
      name: 'Centro Acopio E2E',
      role: Role.CENTRO_ACOPIO,
      isActive: true,
      deletedAt: null,
      publicKey: 'GC7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    },
    [storeUserId]: {
      id: storeUserId,
      email: 'tienda@livora.pe',
      name: 'Tienda Eco E2E',
      role: Role.TIENDA,
      isActive: true,
      deletedAt: null,
      publicKey: 'GD7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    },
  };

  let currentAuthUserId = householdId;

  beforeAll(async () => {
    const supabaseMock = {
      getClient: () => ({
        auth: {
          getUser: jest.fn().mockImplementation((token: string) => {
            const uid = token.replace('Bearer ', '').trim();
            const user = mockUsers[uid] || mockUsers[currentAuthUserId];
            return Promise.resolve({
              data: { user: { id: user.id, email: user.email } },
              error: null,
            });
          }),
        },
      }),
    };

    const blockchainMock = {
      checkConnection: jest.fn().mockResolvedValue(true),
      executeBatchMint: jest.fn().mockResolvedValue({
        success: true,
        txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      }),
      executeRedemptionTransfer: jest.fn().mockResolvedValue({
        success: true,
        txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      }),
    };

    const rpcManagerMock = {
      executeWithFailover: jest.fn().mockImplementation((fn) => {
        return fn({
          getAccount: jest.fn().mockResolvedValue({
            accountId: () => 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
            sequenceNumber: () => '100',
            incrementSequenceNumber: jest.fn(),
          }),
        });
      }),
    };

    const usersServiceMock = {
      findById: jest.fn().mockImplementation((id: string) => {
        return Promise.resolve(
          mockUsers[id] || {
            id,
            email: `${id}@livora.pe`,
            role: Role.CENTRO_ACOPIO,
            isActive: true,
            deletedAt: null,
          },
        );
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseService)
      .useValue(supabaseMock)
      .overrideProvider(BlockchainService)
      .useValue(blockchainMock)
      .overrideProvider(StellarRpcManagerService)
      .useValue(rpcManagerMock)
      .overrideProvider(UsersService)
      .useValue(usersServiceMock)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get<PrismaService>(PrismaService);
    redis = app.get<RedisService>(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Step 1: Healthcheck should return UP status for all subsystems', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.details.database).toBe('UP');
    expect(body.details.redis).toBe('UP');
  });

  it('Step 2: Prometheus /metrics should be accessible publicly and expose core metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).toContain('bullmq_queue_depth');
    expect(res.payload).toContain('stellar_soroban_rpc_latency_seconds');
  });

  it('Step 3: Missing Idempotency-Key on critical financial/weighing endpoint should return HTTP 400', async () => {
    const batchId = crypto.randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batchId}/receive`,
      headers: {
        authorization: `Bearer ${centerUserId}`,
      },
      payload: {
        materialsActual: { PET_PLASTIC: 15.5 },
      },
    });

    expect(res.statusCode).toBe(HttpStatus.BAD_REQUEST);
    const body = JSON.parse(res.payload);
    expect(body.message).toContain("Idempotency-Key' es obligatorio");
  });

  it('Step 4: Idempotent request should process initially and return cached result on duplicate', async () => {
    const idempotencyKey = crypto.randomUUID();
    const testPayload = { statusCode: 202, body: { status: 'PROCESSING', batchId: 'b-999' } };

    // Pre-poblar caché de idempotencia simulada
    await redis.set(`idempotency:${idempotencyKey}`, JSON.stringify(testPayload), 86400);

    const res = await app.inject({
      method: 'POST',
      url: `/batches/${crypto.randomUUID()}/receive`,
      headers: {
        authorization: `Bearer ${centerUserId}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        materialsActual: { PET_PLASTIC: 10.0 },
      },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.payload);
    expect(body.batchId).toBe('b-999');
    expect(body.status).toBe('PROCESSING');
  });

  it('Step 5: Body size exceeding 1MB (1048576 bytes) should be rejected by Fastify with HTTP 413', async () => {
    const largeString = 'X'.repeat(1024 * 1024 + 100); // > 1MB

    const res = await app.inject({
      method: 'POST',
      url: '/complaints',
      payload: {
        consumerName: 'Test',
        description: largeString,
      },
    });

    expect(res.statusCode).toBe(413); // Payload Too Large
  });
});
