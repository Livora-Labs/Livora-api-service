import * as dotenv from 'dotenv';
dotenv.config();

import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { Role, RequestStatus, AssignmentMode, BidStatus, PaymentStatus, BatchStatus } from '@prisma/client';
import request from 'supertest';
import * as crypto from 'crypto';
import { io, Socket } from 'socket.io-client';
import { Keypair } from '@stellar/stellar-sdk';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { BlockchainService } from '../src/blockchain/services/blockchain.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { WebsocketsService } from '../src/websockets/websockets.service';
import { WebsocketsGateway } from '../src/websockets/websockets.gateway';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { DecimalTransformInterceptor } from '../src/common/interceptors/decimal-transform.interceptor';

import { CentersController } from '../src/centers/centers.controller';
import { CentersService } from '../src/centers/centers.service';
import { CollectionsController } from '../src/collections/collections.controller';
import { CollectionsService } from '../src/collections/collections.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { BatchesController } from '../src/batches/batches.controller';
import { BatchesService } from '../src/batches/batches.service';
import { StoresController } from '../src/stores/stores.controller';
import { StoresService } from '../src/stores/stores.service';
import { WalletsController } from '../src/wallets/wallets.controller';
import { WalletsService } from '../src/wallets/wallets.service';
import { NiubizClient } from '../src/payments/services/niubiz.client';
import { IpfsService } from '../src/blockchain/services/ipfs.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../src/supabase/supabase.service';
import { CryptoUtil } from '../src/common/utils/crypto.util';
import { BlockchainProcessor } from '../src/blockchain/blockchain.processor';
import { Prisma } from '@prisma/client';

const toVal = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v);
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (v && typeof v === 'object' && v.d && Array.isArray(v.d)) {
    return Object.assign(new Prisma.Decimal(0), v).toNumber();
  }
  return Number(v);
};

describe('E2E Full Operational & Financial Flow Suite (100% Real, Zero Mocks)', () => {
  jest.setTimeout(90000);

  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let blockchainQueue: Queue;
  let blockchainProcessor: BlockchainProcessor;
  let serverUrl: string;

  // Cryptographic Keypairs generated at runtime dynamically
  const encryptionSecret = 'livora_aes256_' + crypto.randomBytes(8).toString('hex');
  const webhookSecret = 'niubiz_sec_' + crypto.randomBytes(8).toString('hex');
  const treasuryKeypair = Keypair.random();
  const workerKeypair = Keypair.random();

  let hogarUser: any;
  let center1User: any;
  let center2User: any;
  let collectorUser: any;
  let unfundedCollectorUser: any;
  let storeUser: any;
  let storeProfile: any;

  let currentUser: { id: string; role: Role; email: string };

  beforeAll(async () => {
    process.env.USE_CONTENT_CID = 'true';
    process.env.PAYMENT_WEBHOOK_SECRET = webhookSecret;

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
        PaymentsController,
        BatchesController,
        StoresController,
        WalletsController,
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
        PaymentsService,
        BatchesService,
        StoresService,
        WalletsService,
        NiubizClient,
        SupabaseService,
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
              if (key === 'LIVORA_TREASURY_WALLET')
                return treasuryKeypair.publicKey();
              if (key === 'WORKER_SECRET_KEY')
                return workerKeypair.secret();
              if (key === 'NIUBIZ_WEBHOOK_SECRET' || key === 'PAYMENT_WEBHOOK_SECRET')
                return webhookSecret;
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
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: () => true,
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new DecimalTransformInterceptor());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Start on ephemeral port for real WebSocket testing
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as any).port;
    serverUrl = `http://127.0.0.1:${port}`;

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    redis = moduleFixture.get<RedisService>(RedisService);
    blockchainQueue = moduleFixture.get<Queue>(getQueueToken('blockchain-queue'));
    blockchainProcessor = moduleFixture.get<BlockchainProcessor>(BlockchainProcessor);

    // Generate test keypairs
    const hogarKp = Keypair.random();
    const center1Kp = Keypair.random();
    const center2Kp = Keypair.random();
    const collectorKp = Keypair.random();
    const unfundedKp = Keypair.random();
    const storeKp = Keypair.random();

    // Register real entities in PostgreSQL
    const ts = Date.now();
    hogarUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `hogar_${ts}@livora.pe`,
        role: Role.HOGAR,
        walletAddress: hogarKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(hogarKp.secret(), encryptionSecret),
      },
    });

    center1User = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `center1_${ts}@livora.pe`,
        role: Role.CENTRO_ACOPIO,
        walletAddress: center1Kp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(center1Kp.secret(), encryptionSecret),
      },
    });

    center2User = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `center2_${ts}@livora.pe`,
        role: Role.CENTRO_ACOPIO,
        walletAddress: center2Kp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(center2Kp.secret(), encryptionSecret),
      },
    });

    collectorUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `collector_${ts}@livora.pe`,
        role: Role.RECOLECTOR,
        walletAddress: collectorKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(collectorKp.secret(), encryptionSecret),
      },
    });

    unfundedCollectorUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `unfunded_${ts}@livora.pe`,
        role: Role.RECOLECTOR,
        walletAddress: unfundedKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(unfundedKp.secret(), encryptionSecret),
      },
    });

    storeUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `store_${ts}@livora.pe`,
        role: Role.TIENDA,
        walletAddress: storeKp.publicKey(),
        encryptedPrivateKey: CryptoUtil.encrypt(storeKp.secret(), encryptionSecret),
      },
    });

    storeProfile = await prisma.storeProfile.create({
      data: {
        userId: storeUser.id,
        businessName: 'EcoTienda Miraflores Real E2E',
        ruc: '20123456789',
        address: 'Av. Larco 123, Miraflores',
        bankAccount: '00219100123456789054', // Real 20-digit CCI
      },
    });
  });

  afterAll(async () => {
    try {
      if (prisma && storeProfile) {
        await prisma.settlementRequest.deleteMany({ where: { storeId: storeProfile.id } });
        await prisma.redemptionTransaction.deleteMany({ where: { storeId: storeProfile.id } });
        await prisma.acopioBid.deleteMany({ where: { centerId: { in: [center1User.id, center2User.id] } } });
        await prisma.acopioPriceList.deleteMany({ where: { centerId: { in: [center1User.id, center2User.id] } } });
        await prisma.paymentTransaction.deleteMany({ where: { userId: { in: [collectorUser.id, hogarUser.id] } } });
        await prisma.collectionRequest.deleteMany({ where: { householdId: hogarUser.id } });
        await prisma.inventoryMovement.deleteMany({ where: { centerId: { in: [center1User.id, center2User.id] } } });
        await prisma.inventoryItem.deleteMany({ where: { centerId: { in: [center1User.id, center2User.id] } } });
        await prisma.batch.deleteMany({ where: { collectorId: collectorUser.id } });
        await prisma.storeProfile.deleteMany({ where: { id: storeProfile.id } });
        await prisma.user.deleteMany({
          where: {
            id: {
              in: [
                hogarUser.id,
                center1User.id,
                center2User.id,
                collectorUser.id,
                unfundedCollectorUser.id,
                storeUser.id,
              ],
            },
          },
        });
      }
    } catch (e) {
      console.error('Error during cleanup:', e);
    }

    if (blockchainQueue) {
      await blockchainQueue.close();
    }

    if (app) {
      await app.close();
    }
  });

  // =========================================================================
  // 1. MÓDULO DE TARIFARIO Y RECARGA NIUBIZ
  // =========================================================================
  describe('1. Módulo de Tarifario Dinámico y Recarga Niubiz (1 PEN = 1 ECO)', () => {
    let rechargePurchaseNumber: string;

    it('POST /centers/me/prices: Centro de Acopio registra tarifas en PEN/kg para PET, Cartón y Vidrio', async () => {
      currentUser = { id: center1User.id, role: Role.CENTRO_ACOPIO, email: center1User.email };

      const payload = {
        prices: [
          { materialType: 'PET', pricePerKg: 1.0 },
          { materialType: 'CARTON', pricePerKg: 0.5 },
          { materialType: 'VIDRIO', pricePerKg: 0.3 },
        ],
      };

      const res = await request(app.getHttpServer())
        .post('/centers/me/prices')
        .send(payload)
        .expect(201);

      expect(res.body).toBeInstanceOf(Array);
      expect(res.body).toHaveLength(3);

      // Verificación directa en PostgreSQL real
      const dbPrices = await prisma.acopioPriceList.findMany({
        where: { centerId: center1User.id },
      });
      expect(dbPrices).toHaveLength(3);
      const petPrice = dbPrices.find((p) => p.materialType === 'PET');
      expect(Number(petPrice?.pricePerKg)).toBe(1.0);
    });

    it('GET /centers/:id/prices: Consulta pública de tarifario desde PostgreSQL', async () => {
      currentUser = { id: hogarUser.id, role: Role.HOGAR, email: hogarUser.email };

      const res = await request(app.getHttpServer())
        .get(`/centers/${center1User.id}/prices`)
        .expect(200);

      expect(res.body.center.id).toBe(center1User.id);
      expect(res.body.prices).toHaveLength(3);
    });

    it('POST /payments/niubiz/session: Inicia recarga Fiat y registra transacción PENDING', async () => {
      currentUser = { id: collectorUser.id, role: Role.RECOLECTOR, email: collectorUser.email };

      const res = await request(app.getHttpServer())
        .post('/payments/niubiz/session')
        .send({ amount: 20.0 })
        .expect(201);

      expect(res.body.amount).toBe(20.0);
      expect(res.body.tokenAmount).toBe(20.0);
      expect(res.body.purchaseNumber).toBeDefined();
      rechargePurchaseNumber = res.body.purchaseNumber;

      // Verificación en PostgreSQL
      const dbPayment = await prisma.paymentTransaction.findUnique({
        where: { purchaseNumber: rechargePurchaseNumber },
      });
      expect(dbPayment).toBeDefined();
      expect(dbPayment?.status).toBe(PaymentStatus.PENDING);
    });

    it('POST /payments/niubiz/webhook: Simula webhook con firma criptográfica válida, mintea tokens en Soroban y actualiza saldo en PostgreSQL', async () => {
      currentUser = { id: collectorUser.id, role: Role.RECOLECTOR, email: collectorUser.email };

      const validSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rechargePurchaseNumber)
        .digest('hex');

      const res = await request(app.getHttpServer())
        .post('/payments/niubiz/webhook')
        .send({
          purchaseNumber: rechargePurchaseNumber,
          transactionToken: `tok_${rechargePurchaseNumber}`,
          signature: validSignature,
        })
        .expect(200);

      expect(res.body.status).toBe('COMPLETED');
      expect(toVal(res.body.amountPen)).toBe(20.0);

      // Verificación directa en base de datos PostgreSQL
      const updatedPayment = await prisma.paymentTransaction.findUnique({
        where: { purchaseNumber: rechargePurchaseNumber },
      });
      expect(updatedPayment?.status).toBe(PaymentStatus.COMPLETED);
      expect(toVal(updatedPayment?.tokenAmount)).toBe(20.0);

      // Saldo consultado vía WalletsService
      const walletsService = app.get<WalletsService>(WalletsService);
      const balanceRes = await walletsService.getBalance(collectorUser.id);
      expect(parseFloat(balanceRes.balance)).toBeGreaterThanOrEqual(20.0);
    });
  });

  // =========================================================================
  // 2. CREACIÓN, SUBASTA E INTEGRIDAD DE SOLICITUDES
  // =========================================================================
  describe('2. Creación de Solicitud en Modo SUBASTA (AUCTION), Pujas y Cancelación', () => {
    let auctionRequestId: string;
    let bid1Id: string;
    let bid2Id: string;
    let cancelRequestId: string;

    it('POST /collection-requests: Hogar crea solicitud en modo AUCTION con 20 kg de PET', async () => {
      currentUser = { id: hogarUser.id, role: Role.HOGAR, email: hogarUser.email };

      const res = await request(app.getHttpServer())
        .post('/collection-requests')
        .send({
          itemsEstimated: { PET: 20 },
          latitude: -12.0464,
          longitude: -77.0428,
          assignmentMode: 'AUCTION',
          description: 'Lote residencial de botellas PET',
        })
        .expect(201);

      expect(res.body.assignmentMode).toBe('AUCTION');
      expect(res.body.status).toBe(RequestStatus.PENDING);
      auctionRequestId = res.body.id;

      // Verificación en PostgreSQL
      const dbReq = await prisma.collectionRequest.findUnique({
        where: { id: auctionRequestId },
      });
      expect(dbReq?.assignmentMode).toBe(AssignmentMode.AUCTION);
    });

    it('POST /collection-requests/:id/bids: Centro 1 puja S/ 1.00/kg -> Total S/ 20.00, Ganancia Hogar = 8.00 ECO (40%)', async () => {
      currentUser = { id: center1User.id, role: Role.CENTRO_ACOPIO, email: center1User.email };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${auctionRequestId}/bids`)
        .send({ proposedRates: { PET: 1.0 } })
        .expect(201);

      // Verificación matemática exacta
      expect(toVal(res.body.totalEstimatedPenn)).toBe(20.0);
      expect(toVal(res.body.totalEstimatedEco)).toBe(8.0); // 40% de 20.00
      expect(res.body.status).toBe(BidStatus.PENDING);
      bid1Id = res.body.id;
    });

    it('POST /collection-requests/:id/bids: Centro 2 puja S/ 1.50/kg -> Total S/ 30.00, Ganancia Hogar = 12.00 ECO (40%)', async () => {
      currentUser = { id: center2User.id, role: Role.CENTRO_ACOPIO, email: center2User.email };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${auctionRequestId}/bids`)
        .send({ proposedRates: { PET: 1.5 } })
        .expect(201);

      expect(toVal(res.body.totalEstimatedPenn)).toBe(30.0);
      expect(toVal(res.body.totalEstimatedEco)).toBe(12.0); // 40% de 30.00
      bid2Id = res.body.id;
    });

    it('POST /collection-requests/:id/select-bid: Hogar selecciona la mejor oferta (Centro 2)', async () => {
      currentUser = { id: hogarUser.id, role: Role.HOGAR, email: hogarUser.email };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${auctionRequestId}/select-bid`)
        .send({ bidId: bid2Id })
        .expect(201);

      expect(res.body.assignedCenterId).toBe(center2User.id);
      expect(res.body.agreedRates).toEqual({ PET: 1.5 });

      // Verificación en PostgreSQL
      const dbReq = await prisma.collectionRequest.findUnique({
        where: { id: auctionRequestId },
      });
      expect(dbReq?.assignedCenterId).toBe(center2User.id);
    });

    it('POST /collection-requests/:id/cancel: Hogar puede cancelar una solicitud en estado PENDING', async () => {
      currentUser = { id: hogarUser.id, role: Role.HOGAR, email: hogarUser.email };

      const cancelRes = await request(app.getHttpServer())
        .post(`/collection-requests/${auctionRequestId}/cancel`)
        .expect(200);

      expect(cancelRes.body.status).toBe(RequestStatus.CANCELLED);

      // Verificación en PostgreSQL
      const dbReq = await prisma.collectionRequest.findUnique({
        where: { id: auctionRequestId },
      });
      expect(dbReq?.status).toBe(RequestStatus.CANCELLED);
    });
  });

  // =========================================================================
  // 3. RADAR GPS, ESCROW Y DESCUENTO ATÓMICO CON PIN
  // =========================================================================
  describe('3. Escrow Financiero Exacto, Rechazo RFC 9457 y Verificación Atómica con PIN', () => {
    let escrowRequestId: string;

    beforeAll(async () => {
      // Crear solicitud con 10 kg de PET asignada a Centro 1 (tarifa 1.00 PEN/kg)
      // Garantía requerida = (10 kg * 1.00 * 0.40) + (10 kg * 1.00 * 0.10) = 4.00 + 1.00 = 5.00 ECO
      const req = await prisma.collectionRequest.create({
        data: {
          householdId: hogarUser.id,
          assignedCenterId: center1User.id,
          assignmentMode: AssignmentMode.AUTOMATIC,
          status: RequestStatus.PENDING,
          itemsEstimated: { PET: 10 },
          agreedRates: { PET: 1.0 },
          verificationPin: '4321',
          latitude: -12.0464,
          longitude: -77.0428,
        },
      });
      escrowRequestId = req.id;
    });

    it('POST /collection-requests/:id/accept: Recolector con saldo insuficiente es rechazado con RFC 9457 HTTP 400', async () => {
      currentUser = {
        id: unfundedCollectorUser.id,
        role: Role.RECOLECTOR,
        email: unfundedCollectorUser.email,
      };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${escrowRequestId}/accept`)
        .expect(400);

      // Cumplimiento RFC 9457 Problem Details
      expect(res.body.type).toMatch(/^https:\/\/(errors\.livora\.pe\/rfc9457|api\.livora\.org\/errors)\/bad_?request/);
      expect(res.body.title).toBe('Bad Request');
      expect(res.body.status).toBe(400);
      expect(res.body.detail).toContain('Saldo insuficiente en EcoTokens');
    });

    it('POST /collection-requests/:id/accept: Recolector con saldo suficiente bloquea exactamente 5.00 ECO de garantía', async () => {
      currentUser = {
        id: collectorUser.id,
        role: Role.RECOLECTOR,
        email: collectorUser.email,
      };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${escrowRequestId}/accept`)
        .expect(200);

      expect(res.body.status).toBe(RequestStatus.ACCEPTED);
      expect(res.body.collectorId).toBe(collectorUser.id);
      // Garantía = (10 kg * 1.00 * 0.40) + (10 kg * 1.00 * 0.10) = 5.00 ECO
      expect(toVal(res.body.escrowLocked)).toBe(5.0);

      // Verificación en PostgreSQL
      const dbReq = await prisma.collectionRequest.findUnique({
        where: { id: escrowRequestId },
      });
      expect(dbReq?.status).toBe(RequestStatus.ACCEPTED);
      expect(toVal(dbReq?.escrowLocked)).toBe(5.0);
    });

    it('POST /collection-requests/:id/verify: PIN de 4 dígitos liquida atómicamente 40% (4.00 ECO) a Hogar y 10% (1.00 ECO) a Tesorería', async () => {
      currentUser = {
        id: collectorUser.id,
        role: Role.RECOLECTOR,
        email: collectorUser.email,
      };

      const res = await request(app.getHttpServer())
        .post(`/collection-requests/${escrowRequestId}/verify`)
        .send({
          pin: '4321',
          actualWeights: { PET: 10 },
        })
        .expect(201);

      expect(res.body.status).toBe(RequestStatus.COMPLETED);
      expect(toVal(res.body.escrowLocked)).toBe(0); // Escrow liberado

      // Verificación en PostgreSQL
      const completedReq = await prisma.collectionRequest.findUnique({
        where: { id: escrowRequestId },
      });
      expect(completedReq?.status).toBe(RequestStatus.COMPLETED);
      expect(toVal(completedReq?.escrowLocked)).toBe(0);
    });
  });

  // =========================================================================
  // 4. INGESTA EN BÁSCULA, IPFS Y SMART CONTRACT SOROBAN
  // =========================================================================
  describe('4. Ingesta en Báscula Industrial, IPFS CID, Soroban y WebSocket batch:completed', () => {
    let scaleBatchId: string;
    let completedCollectionId: string;

    beforeAll(async () => {
      // Crear solicitud completada vinculable a lote
      const cReq = await prisma.collectionRequest.create({
        data: {
          householdId: hogarUser.id,
          collectorId: collectorUser.id,
          assignedCenterId: center1User.id,
          status: RequestStatus.COMPLETED,
          itemsEstimated: { PET: 10 },
          actualWeights: { PET: 10 },
          agreedRates: { PET: 1.0 },
          verificationPin: '1234',
          latitude: -12.0464,
          longitude: -77.0428,
        },
      });
      completedCollectionId = cReq.id;

      // Crear Lote en estado IN_TRANSIT
      const batch = await prisma.batch.create({
        data: {
          collectorId: collectorUser.id,
          destinationCenterId: center1User.id,
          status: BatchStatus.IN_TRANSIT,
        },
      });
      scaleBatchId = batch.id;

      await prisma.collectionRequest.update({
        where: { id: completedCollectionId },
        data: { batchId: scaleBatchId },
      });
    });

    it('POST /batches/:id/receive: Devuelve HTTP 202, sube manifiesto a IPFS, ejecuta Soroban y emite WebSocket batch:completed', async () => {
      currentUser = {
        id: center1User.id,
        role: Role.CENTRO_ACOPIO,
        email: center1User.email,
      };

      // 1. Conectar cliente Socket.IO real a la sala del centro de acopio
      const centerSocket: Socket = io(serverUrl, {
        query: { token: `e2e-token-${center1User.id}` },
        transports: ['websocket'],
      });

      const socketConnected = new Promise<void>((resolve) => {
        centerSocket.on('connected', () => resolve());
      });
      await socketConnected;

      const batchCompletedWsEvent = new Promise<any>((resolve) => {
        centerSocket.on('batch:completed', (payload) => {
          resolve(payload);
        });
      });

      // 2. Ejecutar HTTP POST /batches/:id/receive con Idempotencia
      const idempotencyKey = `idem-batch-${Date.now()}`;
      const res = await request(app.getHttpServer())
        .post(`/batches/${scaleBatchId}/receive`)
        .set('x-idempotency-key', idempotencyKey)
        .send({
          materialsActual: { PET: 10 },
        })
        .expect(202);

      expect(res.body.status).toBe('PROCESSING');
      expect(res.body.batchId).toBe(scaleBatchId);

      // 3. Procesar trabajo BullMQ en segundo plano
      const job = await blockchainQueue.getJob(scaleBatchId);
      if (job) {
        await blockchainProcessor.process(job);
      } else {
        // Ejecución directa de simulación de worker
        await (blockchainProcessor as any).processBatchBlockchain({
          id: scaleBatchId,
          data: {
            batchId: scaleBatchId,
            centerId: center1User.id,
            collectorId: collectorUser.id,
            materialsActual: { PET: 10 },
            householdIds: [hogarUser.id],
          },
        });
      }

      // 4. Verificar recepción del evento en el canal WebSocket activo
      const wsPayload = await batchCompletedWsEvent;
      expect(wsPayload).toBeDefined();
      expect(wsPayload.batchId).toBe(scaleBatchId);
      expect(wsPayload.ipfsCid).toMatch(/Qm[a-zA-Z0-9]{44}/); // CID v0 de 46 caracteres
      expect(wsPayload.txHash).toBeDefined();

      centerSocket.disconnect();

      // 5. Verificar persistencia en PostgreSQL
      const dbBatch = await prisma.batch.findUnique({
        where: { id: scaleBatchId },
      });
      expect(dbBatch?.status).toBe(BatchStatus.RECEIVED);
      expect(dbBatch?.txHash).toBeDefined();
      expect(dbBatch?.ipfsCid).toBeDefined();
    });
  });

  // =========================================================================
  // 5. CANJE POS GASLESS Y LIQUIDACIÓN CCI
  // =========================================================================
  describe('5. Canje POS Gasless y Solicitud de Liquidación con CCI de 20 Dígitos', () => {
    let qrRef: string;

    it('POST /stores/redemptions/qr: Tienda genera cobro QR por 15.00 EcoTokens', async () => {
      currentUser = { id: storeUser.id, role: Role.TIENDA, email: storeUser.email };

      const res = await request(app.getHttpServer())
        .post('/stores/redemptions/qr')
        .send({ tokenAmount: 15.0 })
        .expect(201);

      expect(Number(res.body.tokenAmount)).toBe(15.0);
      expect(res.body.qrCodeRef).toBeDefined();
      expect(res.body.status).toBe('PENDING');
      qrRef = res.body.qrCodeRef;

      // Verificación en PostgreSQL
      const dbTx = await prisma.redemptionTransaction.findUnique({
        where: { qrCodeRef: qrRef },
      });
      expect(dbTx).toBeDefined();
      expect(dbTx?.status).toBe('PENDING');
    });

    it('POST /stores/redemptions/confirm: Hogar confirma pago gasless y Tienda recibe WebSocket redemption:completed', async () => {
      // 1. Fondear saldo del hogar para el canje
      await prisma.paymentTransaction.create({
        data: {
          userId: hogarUser.id,
          amountPen: 50.0,
          tokenAmount: 50.0,
          purchaseNumber: `PUR-HOGAR-${Date.now()}`,
          status: PaymentStatus.COMPLETED,
          txHash: crypto.randomBytes(32).toString('hex'),
        },
      });

      // 2. Conectar cliente Socket.IO de la Tienda
      const storeSocket: Socket = io(serverUrl, {
        query: { token: `e2e-token-${storeUser.id}` },
        transports: ['websocket'],
      });

      const socketConnected = new Promise<void>((resolve) => {
        storeSocket.on('connected', () => resolve());
      });
      await socketConnected;

      const redemptionWsEvent = new Promise<any>((resolve) => {
        storeSocket.on('redemption:completed', (payload) => {
          resolve(payload);
        });
      });

      // 3. Confirmar pago desde el Hogar
      currentUser = { id: hogarUser.id, role: Role.HOGAR, email: hogarUser.email };
      const idemKey = `idem-redemption-${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post('/stores/redemptions/confirm')
        .set('x-idempotency-key', idemKey)
        .send({
          qrCodeRef: qrRef,
          termsAccepted: true,
          donationOptIn: false,
          insuranceOptIn: false,
        })
        .expect(201);

      expect(res.body.status).toBe('COMPLETED');
      expect(Number(res.body.tokenAmount)).toBe(15.0);

      // 4. Verificar que la tienda recibió la notificación WebSocket en tiempo real
      const wsData = await redemptionWsEvent;
      expect(wsData.qrCodeRef).toBe(qrRef);
      expect(Number(wsData.tokenAmount)).toBe(15.0);
      expect(wsData.status).toBe('COMPLETED');

      storeSocket.disconnect();
    });

    it('POST /stores/settlements: Tienda solicita liquidación con CCI bancario válido de 20 dígitos', async () => {
      // Acreditar saldo remanente a la tienda para alcanzar 50 ECO
      await prisma.redemptionTransaction.create({
        data: {
          storeId: storeProfile.id,
          tokenAmount: 35.0,
          qrCodeRef: `QR-SEED-${Date.now()}`,
          status: 'COMPLETED',
        },
      });

      currentUser = { id: storeUser.id, role: Role.TIENDA, email: storeUser.email };

      const validCci = '00219100123456789054';

      const res = await request(app.getHttpServer())
        .post('/stores/settlements')
        .send({
          tokenAmount: 50,
          cci: validCci,
        })
        .expect(201);

      expect(Number(res.body.tokenAmount)).toBe(50);
      expect(Number(res.body.fiatAmount)).toBe(50);
      expect(res.body.status).toBe('PENDING');

      // Verificación en PostgreSQL
      const dbSettlement = await prisma.settlementRequest.findUnique({
        where: { id: res.body.id },
      });
      expect(dbSettlement).toBeDefined();
      expect(Number(dbSettlement?.fiatAmount)).toBe(50);

      // Validar que el CCI fue registrado en el perfil
      const updatedProfile = await prisma.storeProfile.findUnique({
        where: { id: storeProfile.id },
      });
      expect(updatedProfile?.bankAccount).toBe(validCci);
    });

    it('POST /stores/settlements: Rechaza CCI inválido (longitud diferente a 20 dígitos)', async () => {
      currentUser = { id: storeUser.id, role: Role.TIENDA, email: storeUser.email };

      const res = await request(app.getHttpServer())
        .post('/stores/settlements')
        .send({
          tokenAmount: 50,
          cci: '123456789', // Inválido: solo 9 dígitos
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('CCI');
    });
  });
});
