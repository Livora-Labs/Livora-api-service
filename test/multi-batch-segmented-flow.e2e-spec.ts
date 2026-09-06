import * as dotenv from 'dotenv';
dotenv.config();

import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { Role, RequestStatus, AssignmentMode, BatchStatus } from '@prisma/client';
import request from 'supertest';
import * as crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';

import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { BlockchainService } from '../src/blockchain/services/blockchain.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { WebsocketsService } from '../src/websockets/websockets.service';
import { WebsocketsGateway } from '../src/websockets/websockets.gateway';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

import { CentersController } from '../src/centers/centers.controller';
import { CentersService } from '../src/centers/centers.service';
import { CollectionsController } from '../src/collections/collections.controller';
import { CollectionsService } from '../src/collections/collections.service';
import { BatchesController } from '../src/batches/batches.controller';
import { BatchesService } from '../src/batches/batches.service';
import { IpfsService } from '../src/blockchain/services/ipfs.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { NiubizClient } from '../src/payments/services/niubiz.client';
import { ConfigService } from '@nestjs/config';
import { CryptoUtil } from '../src/common/utils/crypto.util';
import { BlockchainProcessor } from '../src/blockchain/blockchain.processor';

describe('E2E Real Process Suite: Lotes Segmentados por Acopio (Multi-Batch Collection Flow)', () => {
  jest.setTimeout(120000);

  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let blockchainQueue: Queue;
  let blockchainProcessor: BlockchainProcessor;
  let blockchainService: BlockchainService;
  let ipfsService: IpfsService;

  const encryptionSecret = 'livora_aes256_' + crypto.randomBytes(8).toString('hex');
  const workerKeypair = Keypair.random();

  let centerAUser: any;
  let centerBUser: any;
  let collectorUser: any;
  let hogar1User: any;
  let hogar2User: any;

  let req1: any;
  let req2: any;
  let batchAId: string;
  let batchBId: string;

  let currentUser: { id: string; role: Role; email: string };

  beforeAll(async () => {
    process.env.USE_CONTENT_CID = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        BullModule.forRootAsync({
          useFactory: () => ({
            connection: {
              host: 'localhost',
              port: 6379,
            },
          }),
        }),
        BullModule.registerQueue({
          name: 'blockchain-queue',
        }),
      ],
      controllers: [
        CentersController,
        CollectionsController,
        BatchesController,
      ],
      providers: [
        PrismaService,
        RedisService,
        BlockchainService,
        IpfsService,
        WebsocketsService,
        WebsocketsGateway,
        NotificationsService,
        BlockchainProcessor,
        CentersService,
        CollectionsService,
        BatchesService,
        SupabaseService,
        NiubizClient,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def?: any) => {
              if (key === 'DATABASE_URL')
                return 'postgresql://livora:livora_secret@localhost:5434/livora_db?schema=public';
              if (key === 'REDIS_HOST') return 'localhost';
              if (key === 'REDIS_PORT') return 6379;
              if (key === 'STELLAR_RPC_URL')
                return 'https://soroban-testnet.stellar.org';
              if (key === 'STELLAR_NETWORK_PASSPHRASE')
                return 'Test SDF Network ; September 2015';
              if (key === 'ECOTOKEN_CONTRACT_ID')
                return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
              if (key === 'WALLET_ENCRYPTION_KEY' || key === 'ENCRYPTION_KEY')
                return encryptionSecret;
              if (key === 'WORKER_SECRET_KEY')
                return workerKeypair.secret();
              if (key === 'USE_CONTENT_CID')
                return 'true';
              if (key === 'SUPABASE_URL')
                return 'https://test-livora.supabase.co';
              if (key === 'SUPABASE_SERVICE_ROLE_KEY')
                return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dummy';
              return def !== undefined ? def : null;
            }),
          },
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = currentUser;
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    redis = moduleFixture.get<RedisService>(RedisService);
    blockchainQueue = moduleFixture.get<Queue>(getQueueToken('blockchain-queue'));
    blockchainProcessor = moduleFixture.get<BlockchainProcessor>(BlockchainProcessor);
    blockchainService = moduleFixture.get<BlockchainService>(BlockchainService);
    ipfsService = moduleFixture.get<IpfsService>(IpfsService);

    // Sembrar entidades reales en PostgreSQL
    const ts = Date.now();
    const centerAKp = Keypair.random();
    const centerBKp = Keypair.random();
    const collectorKp = Keypair.random();
    const hogar1Kp = Keypair.random();
    const hogar2Kp = Keypair.random();

    centerAUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `acopio_a_${ts}@livora.pe`,
        role: Role.CENTRO_ACOPIO,
        name: 'Centro de Acopio EcoNorte',
        walletAddress: centerAKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(centerAKp.secret(), encryptionSecret),
        latitude: -12.0460,
        longitude: -77.0425,
      },
    });

    centerBUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `acopio_b_${ts}@livora.pe`,
        role: Role.CENTRO_ACOPIO,
        name: 'Centro de Acopio ReciclaSur',
        walletAddress: centerBKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(centerBKp.secret(), encryptionSecret),
        latitude: -12.0500,
        longitude: -77.0450,
      },
    });

    collectorUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `recolector_${ts}@livora.pe`,
        role: Role.RECOLECTOR,
        name: 'Carlos Recolector de Ruta',
        walletAddress: collectorKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(collectorKp.secret(), encryptionSecret),
        latitude: -12.0450,
        longitude: -77.0420,
      },
    });

    // Fondear al recolector con EcoTokens vía recarga Niubiz para garantizar el escrow del 50%
    await prisma.paymentTransaction.create({
      data: {
        userId: collectorUser.id,
        purchaseNumber: `PN-INIT-${ts}`,
        amountPen: 200.0,
        tokenAmount: 200.0,
        status: 'COMPLETED',
      },
    });

    hogar1User = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `hogar1_${ts}@livora.pe`,
        role: Role.HOGAR,
        name: 'Familia Perez (Centro A)',
        walletAddress: hogar1Kp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(hogar1Kp.secret(), encryptionSecret),
      },
    });

    hogar2User = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `hogar2_${ts}@livora.pe`,
        role: Role.HOGAR,
        name: 'Familia Gomez (Centro B)',
        walletAddress: hogar2Kp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(hogar2Kp.secret(), encryptionSecret),
      },
    });

    // Crear 2 solicitudes de recolección pendientes asignadas a centros distintos
    req1 = await prisma.collectionRequest.create({
      data: {
        householdId: hogar1User.id,
        assignedCenterId: centerAUser.id,
        status: RequestStatus.PENDING,
        assignmentMode: AssignmentMode.AUTOMATIC,
        itemsEstimated: { PET: 10.0 },
        agreedRates: { PET: 1.50 },
        verificationPin: '1234',
        latitude: -12.0455,
        longitude: -77.0422,
        description: 'Bolsa de botellas PET limpias para Acopio Norte',
      },
    });

    req2 = await prisma.collectionRequest.create({
      data: {
        householdId: hogar2User.id,
        assignedCenterId: centerBUser.id,
        status: RequestStatus.PENDING,
        assignmentMode: AssignmentMode.AUTOMATIC,
        itemsEstimated: { CARTON: 15.0 },
        agreedRates: { CARTON: 0.80 },
        verificationPin: '5678',
        latitude: -12.0490,
        longitude: -77.0445,
        description: 'Cajas de carton corrugado para Acopio Sur',
      },
    });
  });

  afterAll(async () => {
    try {
      if (prisma) {
        const allUserIds = [
          centerAUser?.id,
          centerBUser?.id,
          collectorUser?.id,
          hogar1User?.id,
          hogar2User?.id,
        ].filter(Boolean);

        await prisma.collectionRequest.deleteMany({
          where: {
            OR: [
              { id: { in: [req1?.id, req2?.id].filter(Boolean) } },
              { householdId: { in: allUserIds } },
              { collectorId: { in: allUserIds } },
              { assignedCenterId: { in: allUserIds } },
            ],
          },
        });

        await prisma.batch.deleteMany({
          where: {
            OR: [
              { collectorId: { in: allUserIds } },
              { destinationCenterId: { in: allUserIds } },
            ],
          },
        });

        await prisma.inventoryMovement.deleteMany({
          where: { centerId: { in: allUserIds } },
        });

        await prisma.inventoryItem.deleteMany({
          where: { centerId: { in: allUserIds } },
        });

        await prisma.paymentTransaction.deleteMany({
          where: { userId: { in: allUserIds } },
        });

        await prisma.notification.deleteMany({
          where: { userId: { in: allUserIds } },
        });

        await prisma.user.deleteMany({
          where: { id: { in: allUserIds } },
        });
      }
      if (blockchainQueue) {
        await blockchainQueue.close();
      }
      if (redis) {
        try {
          await redis.getClient()?.quit();
        } catch {
          redis.getClient()?.disconnect();
        }
      }
      if (app) {
        await app.close();
      }
    } catch (err) {
      console.warn('Cleanup error in E2E:', err);
    }
  });

  describe('1. Radar GPS y Filtros Inteligentes (GET /collection-requests/available)', () => {
    it('debe listar solicitudes cercanas ordenadas por distancia geodésica ascendente protegiendo el PIN', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .get('/collection-requests/available')
        .query({
          lat: -12.0450,
          lng: -77.0420,
          radiusKm: 5,
        });

      expect(res.status).toBe(200);
      const items = Array.isArray(res.body) ? res.body : res.body.data;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(2);

      const found1 = items.find((r: any) => r.id === req1.id);
      const found2 = items.find((r: any) => r.id === req2.id);

      expect(found1).toBeDefined();
      expect(found2).toBeDefined();

      // El PIN no debe filtrarse al recolector antes de la entrega presencial
      expect(found1.verificationPin).toBeUndefined();
      expect(found2.verificationPin).toBeUndefined();

      // req1 está a ~60m, req2 a ~500m -> req1 debe preceder a req2
      const idx1 = items.findIndex((r: any) => r.id === req1.id);
      const idx2 = items.findIndex((r: any) => r.id === req2.id);
      expect(idx1).toBeLessThan(idx2);
    });

    it('debe filtrar exclusivamente por acopio cuando se envía centerId', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .get('/collection-requests/available')
        .query({
          lat: -12.0450,
          lng: -77.0420,
          radiusKm: 5,
          centerId: centerAUser.id,
        });

      expect(res.status).toBe(200);
      const items = Array.isArray(res.body) ? res.body : res.body.data;
      const found1 = items.find((r: any) => r.id === req1.id);
      const found2 = items.find((r: any) => r.id === req2.id);

      expect(found1).toBeDefined();
      expect(found2).toBeUndefined();
    });

    it('con onlyActiveBatches=true retorna vacío si el recolector aún no tiene lotes OPEN en camión', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .get('/collection-requests/available')
        .query({
          lat: -12.0450,
          lng: -77.0420,
          radiusKm: 5,
          onlyActiveBatches: true,
        });

      expect(res.status).toBe(200);
      const items = Array.isArray(res.body) ? res.body : res.body.data;
      const ourRequests = items.filter(
        (r: any) => r.id === req1.id || r.id === req2.id,
      );
      expect(ourRequests.length).toBe(0);
    });
  });

  describe('2. Aceptación de Solicitudes y Auto-creación de Sub-Lotes Segmentados', () => {
    it('al aceptar req1 (Centro A), crea automáticamente un sub-lote OPEN para Centro A y vincula batchId', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${req1.id}/accept`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACCEPTED');
      expect(res.body.collectorId).toBe(collectorUser.id);
      expect(res.body.batchId).toBeDefined();

      batchAId = res.body.batchId;

      // Verificar en PostgreSQL que el lote creado pertenece estrictamente a Centro A
      const batchA = await prisma.batch.findUnique({
        where: { id: batchAId },
      });
      expect(batchA).toBeDefined();
      expect(batchA!.status).toBe(BatchStatus.OPEN);
      expect(batchA!.collectorId).toBe(collectorUser.id);
      expect(batchA!.destinationCenterId).toBe(centerAUser.id);
    });

    it('radar con onlyActiveBatches=true ahora incluye solicitudes de Centro A pero no de Centro B', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .get('/collection-requests/available')
        .query({
          lat: -12.0450,
          lng: -77.0420,
          radiusKm: 5,
          onlyActiveBatches: true,
        });

      expect(res.status).toBe(200);
      // req2 es de Centro B -> no debe aparecer en la ruta activa de Centro A
      const items = Array.isArray(res.body) ? res.body : res.body.data;
      const found2 = items.find((r: any) => r.id === req2.id);
      expect(found2).toBeUndefined();
    });

    it('al aceptar req2 (Centro B), crea un SEGUNDO sub-lote OPEN paralelo e independiente para Centro B', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${req2.id}/accept`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACCEPTED');
      expect(res.body.collectorId).toBe(collectorUser.id);
      expect(res.body.batchId).toBeDefined();

      batchBId = res.body.batchId;

      // Regla de Negocio: Ambos sub-lotes deben tener IDs diferentes porque son de acopios distintos
      expect(batchBId).not.toBe(batchAId);

      const batchB = await prisma.batch.findUnique({
        where: { id: batchBId },
      });
      expect(batchB).toBeDefined();
      expect(batchB!.status).toBe(BatchStatus.OPEN);
      expect(batchB!.collectorId).toBe(collectorUser.id);
      expect(batchB!.destinationCenterId).toBe(centerBUser.id);
    });
  });

  describe('3. Consulta y Segregación de Lotes Abiertos (GET /batches/open y GET /batches/:id)', () => {
    it('GET /batches/open retorna el arreglo de todos los sub-lotes abiertos en el camión del recolector', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer()).get('/batches/open');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const openIds = res.body.map((b: any) => b.id);
      expect(openIds).toContain(batchAId);
      expect(openIds).toContain(batchBId);

      // Cada sub-lote reporta su acopio de destino independiente
      const subA = res.body.find((b: any) => b.id === batchAId);
      const subB = res.body.find((b: any) => b.id === batchBId);
      expect(subA.destinationCenterId).toBe(centerAUser.id);
      expect(subB.destinationCenterId).toBe(centerBUser.id);
    });

    it('GET /batches/open?centerId filtra únicamente el sub-lote del acopio solicitado', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .get('/batches/open')
        .query({ centerId: centerAUser.id });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(batchAId);
      expect(res.body[0].destinationCenterId).toBe(centerAUser.id);
    });

    it('Centro A puede consultar el detalle de su sub-lote batchA con GET /batches/:id', async () => {
      currentUser = centerAUser;

      const res = await request(app.getHttpServer()).get(`/batches/${batchAId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(batchAId);
      expect(res.body.destinationCenterId).toBe(centerAUser.id);
      expect(res.body.requests).toBeDefined();
    });

    it('Centro B es bloqueado con 403 Forbidden al intentar consultar batchA de Centro A', async () => {
      currentUser = centerBUser;

      const res = await request(app.getHttpServer()).get(`/batches/${batchAId}`);

      expect(res.status).toBe(403);
    });
  });

  describe('4. Verificación Presencial Domiciliaria OTP y Consolidación de Pesos Reales', () => {
    it('recolector verifica req1 en domicilio con PIN de Hogar 1 y consolida peso en sub-lote A', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${req1.id}/verify`)
        .send({
          pin: '1234',
          actualWeights: { PET: 10.5 },
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.actualWeights).toEqual({ PET: 10.5 });

      // Verificar que la solicitud pasó a COMPLETED, registró pesos reales y mantiene el batchId
      const updatedReq1 = await prisma.collectionRequest.findUnique({
        where: { id: req1.id },
      });
      expect(updatedReq1!.status).toBe(RequestStatus.COMPLETED);
      expect(updatedReq1!.actualWeights).toEqual({ PET: 10.5 });
      expect(updatedReq1!.batchId).toBe(batchAId);
    });

    it('recolector verifica req2 en domicilio con PIN de Hogar 2 y consolida peso en sub-lote B', async () => {
      currentUser = collectorUser;

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${req2.id}/verify`)
        .send({
          pin: '5678',
          actualWeights: { CARTON: 14.8 },
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.status).toBe('COMPLETED');

      const updatedReq2 = await prisma.collectionRequest.findUnique({
        where: { id: req2.id },
      });
      expect(updatedReq2!.status).toBe(RequestStatus.COMPLETED);
      expect(updatedReq2!.actualWeights).toEqual({ CARTON: 14.8 });
      expect(updatedReq2!.batchId).toBe(batchBId);
    });
  });

  describe('5. Recepción en Báscula de Planta y Protección Cruzada de Acopios', () => {
    it('Centro B no puede recibir ni pesar el sub-lote A (rechazado con 403 Forbidden)', async () => {
      currentUser = centerBUser;

      const res = await request(app.getHttpServer())
        .post(`/batches/${batchAId}/receive`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          materialsActual: { PET: 10.5 },
        });

      expect(res.status).toBe(403);
    });

    it('Centro A recibe sub-lote A (resiliencia en estado OPEN): retorna HTTP 202 y encola en BullMQ', async () => {
      currentUser = centerAUser;

      const res = await request(app.getHttpServer())
        .post(`/batches/${batchAId}/receive`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          materialsActual: { PET: 10.5 },
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe(BatchStatus.PROCESSING);
      expect(res.body.batchId).toBe(batchAId);

      // Verificar que el lote pasó a PROCESSING en PostgreSQL
      const batchA = await prisma.batch.findUnique({
        where: { id: batchAId },
      });
      expect(batchA!.status).toBe(BatchStatus.PROCESSING);
    });

    it('Centro B recibe sub-lote B: retorna HTTP 202 Accepted y pasa a PROCESSING', async () => {
      currentUser = centerBUser;

      const res = await request(app.getHttpServer())
        .post(`/batches/${batchBId}/receive`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          materialsActual: { CARTON: 14.8 },
        });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe(BatchStatus.PROCESSING);
      expect(res.body.batchId).toBe(batchBId);
    });
  });

  describe('6. Capa Worker Blockchain: Manifiesto IPFS Granular y Acuñación On-Chain', () => {
    it('procesa sub-lote A en el worker: genera Manifiesto Granular Auditado para IPFS y mintea en Stellar', async () => {
      const jobData = {
        batchId: batchAId,
        collectorId: collectorUser.id,
        centerId: centerAUser.id,
        materialsActual: { PET: 10.5 },
        householdIds: [hogar1User.id],
      };

      const jobA = {
        name: 'process-batch-blockchain',
        data: jobData,
        id: `test-batch-${batchAId}`,
      } as unknown as Job<any>;

      const spyUpload = jest.spyOn(ipfsService, 'uploadBatchMetadata');

      // Procesar el trabajo a través de la máquina real del BlockchainProcessor
      await blockchainProcessor.process(jobA);

      // Verificar que el manifiesto IPFS contiene el desglose granular auditado
      expect(spyUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          batchId: batchAId,
          collectorId: collectorUser.id,
          destinationCenterId: centerAUser.id,
          totalKg: 10.5,
          requests: expect.arrayContaining([
            expect.objectContaining({
              requestId: req1.id,
              householdId: hogar1User.id,
              status: 'COMPLETED',
            }),
          ]),
        }),
      );

      // Verificar que el lote A en PostgreSQL pasó a RECEIVED con txHash e ipfsCid
      const finalBatchA = await prisma.batch.findUnique({
        where: { id: batchAId },
      });
      expect(finalBatchA!.status).toBe(BatchStatus.RECEIVED);
      expect(finalBatchA!.txHash).toBeDefined();
      expect(finalBatchA!.ipfsCid).toBeDefined();

      // Verificar que el inventario de Centro A se incrementó para PET
      const inventoryA = await prisma.inventoryItem.findFirst({
        where: { centerId: centerAUser.id, materialType: 'PET' },
      });
      expect(inventoryA).toBeDefined();
      expect(Number(inventoryA!.quantityKg)).toBeGreaterThanOrEqual(10.5);
    });

    it('procesa sub-lote B en el worker: aísla las solicitudes de Centro B e incrementa inventario de Cartón', async () => {
      const jobData = {
        batchId: batchBId,
        collectorId: collectorUser.id,
        centerId: centerBUser.id,
        materialsActual: { CARTON: 14.8 },
        householdIds: [hogar2User.id],
      };

      const jobB = {
        name: 'process-batch-blockchain',
        data: jobData,
        id: `test-batch-${batchBId}`,
      } as unknown as Job<any>;

      const spyUpload = jest.spyOn(ipfsService, 'uploadBatchMetadata');

      await blockchainProcessor.process(jobB);

      expect(spyUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          batchId: batchBId,
          destinationCenterId: centerBUser.id,
          totalKg: 14.8,
          requests: expect.arrayContaining([
            expect.objectContaining({
              requestId: req2.id,
              householdId: hogar2User.id,
            }),
          ]),
        }),
      );

      const finalBatchB = await prisma.batch.findUnique({
        where: { id: batchBId },
      });
      expect(finalBatchB!.status).toBe(BatchStatus.RECEIVED);
      expect(finalBatchB!.txHash).toBeDefined();

      const inventoryB = await prisma.inventoryItem.findFirst({
        where: { centerId: centerBUser.id, materialType: 'CARTON' },
      });
      expect(inventoryB).toBeDefined();
      expect(Number(inventoryB!.quantityKg)).toBeGreaterThanOrEqual(14.8);
    });
  });
});
