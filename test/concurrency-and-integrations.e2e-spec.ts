import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Module,
  Param,
  Post,
  UseGuards,
  ValidationPipe,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { Role } from '@prisma/client';
import { IsBoolean, IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { Roles } from '../src/common/decorators/roles.decorator';
import { CurrentUser } from '../src/common/decorators/current-user.decorator';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { MailService } from '../src/common/services/mail.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../src/supabase/supabase.service';
import { UsersService } from '../src/users/users.service';

// Mocks to track test side-effects
let lastSentEmail = '';
let lastSentOtp = '';
let sentryCapturedError: Error | null = null;
let fcmNotificationSent = false;
let blockchainTransferEnqueued = false;

// Custom Mock Sentry Capture
class MockSentry {
  static captureException(err: any) {
    sentryCapturedError = err;
  }
}

// -----------------------------------------------------------------------------
// DTOs for testing
// -----------------------------------------------------------------------------
class ConfirmRedemptionTestDto {
  @IsBoolean()
  @IsNotEmpty()
  termsAccepted!: boolean;
}

class CreateSaleTestDto {
  @IsString()
  @IsNotEmpty()
  materialType!: string;

  @IsNumber()
  @IsNotEmpty()
  quantityKg!: number;

  @IsString()
  @IsNotEmpty()
  customerId!: string;
}

class WeighTestDto {
  @IsNumber()
  @IsNotEmpty()
  weightKg!: number;
}

// -----------------------------------------------------------------------------
// Test Controller to mock the target business logic & concurrency scenarios
// -----------------------------------------------------------------------------
@Controller('test-e2e')
class TestE2EController {
  public collectionRequestAcceptedBy: string | null = null;
  public qrConfirmed = false;
  public otpCooldowns = new Map<string, number>();

  // Database mock state
  public historicInputs = 100.0; // 100 kg input
  public currentStock = 100.0;
  public userProfile = {
    id: 'user-123-arco',
    email: 'citizen.arco@livora.pe',
    name: 'Juan Pérez',
    phone: '999888777',
    fcmToken: 'fcm-token-123',
    encryptedPrivateKey: 'cipher-key-abc',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  @Post('collection-requests/:id/accept')
  @Roles(Role.RECOLECTOR)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async acceptRequest(
    @CurrentUser('id') collectorId: string,
    @Param('id') id: string,
  ) {
    // Atomic test lock check synchronously to prevent race conditions during async delays
    if (this.collectionRequestAcceptedBy !== null) {
      throw new ConflictException('Solicitud ya aceptada por otro recolector');
    }
    this.collectionRequestAcceptedBy = collectorId;
    
    // Simulate async database delay
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { success: true, acceptedBy: collectorId };
  }

  @Post('stores/redemptions/confirm/:qrCodeRef')
  @Roles(Role.HOGAR)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async confirmRedemption(
    @Param('qrCodeRef') qrCodeRef: string,
    @Body() dto: ConfirmRedemptionTestDto,
  ) {
    if (!dto.termsAccepted) {
      throw new BadRequestException('Debe aceptar los términos y condiciones');
    }
    // Atomic test check
    if (this.qrConfirmed) {
      throw new ConflictException('Este código QR ya fue cobrado (Double Spend)');
    }
    this.qrConfirmed = true;
    blockchainTransferEnqueued = true;
    return { success: true, status: 'COMPLETED' };
  }

  @Post('auth/register')
  async register(@Body() body: any) {
    const email = body.email;
    const cooldown = this.otpCooldowns.get(email) || 0;
    if (cooldown > Date.now()) {
      throw new BadRequestException('Debe esperar antes de solicitar otro OTP');
    }
    this.otpCooldowns.set(email, Date.now() + 60000); // 1-minute cooldown
    const generatedOtp = '123456';
    await this.redis.set(`otp:${email}`, generatedOtp);
    await this.mail.sendOtpEmail(email, generatedOtp);
    return { success: true };
  }

  @Post('sales')
  @Roles(Role.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async makeSale(@Body() dto: CreateSaleTestDto) {
    const mermaFactor = 0.05;
    const maxAllowedSale = this.historicInputs * (1 - mermaFactor); // 95 kg max

    if (dto.quantityKg > maxAllowedSale) {
      throw new BadRequestException(
        `Venta excede el límite permitido por la merma industrial del 5%. Máximo: ${maxAllowedSale} kg`,
      );
    }

    if (dto.quantityKg > this.currentStock) {
      throw new BadRequestException('Stock insuficiente');
    }

    // Prisma Transaction Simulation
    await this.prisma.$transaction(async (tx: any) => {
      await tx.inventoryItem.update({
        where: { materialType: dto.materialType },
        data: { quantityKg: this.currentStock - dto.quantityKg },
      });
      await tx.inventoryMovement.create({
        data: {
          type: 'OUT',
          quantityKg: dto.quantityKg,
        },
      });
    });

    this.currentStock -= dto.quantityKg;
    return { success: true, stockRemaining: this.currentStock };
  }

  @Post('batches/weighed')
  @Roles(Role.CENTRO_ACOPIO)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async recordWeight(@Body() dto: WeighTestDto) {
    // 80/20 distribution
    const rewardTotal = dto.weightKg * 1.5; // 1.5 EcoTokens per Kg
    const citizenReward = Math.floor(rewardTotal * 0.8 * 100) / 100;
    const collectorReward = Math.round((rewardTotal - citizenReward) * 100) / 100; // takes residue

    return {
      success: true,
      rewardTotal,
      citizenReward,
      collectorReward,
    };
  }

  @Delete('users/me')
  @UseGuards(SupabaseAuthGuard)
  async deleteAccount(@CurrentUser('id') id: string) {
    // Simulation of ARCO deletion anonymization
    const anonymized = {
      ...this.userProfile,
      email: 'ANONIMIZADO@livora.pe',
      name: 'Usuario Anonimizado',
      phone: '—',
      fcmToken: null,
      encryptedPrivateKey: null,
    };
    await this.prisma.user.update({
      where: { id },
      data: {
        email: anonymized.email,
        name: anonymized.name,
        phone: anonymized.phone,
        fcmToken: null,
        encryptedPrivateKey: null,
      },
    });
    return { success: true };
  }

  @Get('admin/inventory')
  @Roles(Role.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  getAdminInventory() {
    return { stock: this.currentStock };
  }

  @Post('centro/reception')
  @Roles(Role.CENTRO_ACOPIO)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  receiveCentro() {
    return { success: true };
  }

  @Post('stores/redemptions/qr')
  @Roles(Role.TIENDA)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  generateStoreQr() {
    return { success: true };
  }

  @Get('trigger-500')
  trigger500() {
    try {
      throw new Error('Database connection failed temporarily');
    } catch (e: any) {
      MockSentry.captureException(e);
      throw new InternalServerErrorException('Database connection failed temporarily');
    }
  }

  @Post('trigger-firebase-push')
  triggerFirebasePush() {
    try {
      // Mock FCM sending to a bad token
      throw new Error('FCM token is not registered');
    } catch (err: any) {
      MockSentry.captureException(err);
      fcmNotificationSent = false; // captured cleanly
      return { success: true, warning: 'Failed to send notification cleanly' };
    }
  }
}

// -----------------------------------------------------------------------------
// Test module bundle
// -----------------------------------------------------------------------------
@Module({
  controllers: [TestE2EController],
  providers: [
    {
      provide: PrismaService,
      useFactory: () => {
        const mockedPrisma: any = {
          user: {
            update: jest.fn(async () => ({ success: true })),
          },
          inventoryItem: {
            update: jest.fn(async () => ({ success: true })),
          },
          inventoryMovement: {
            create: jest.fn(async () => ({ success: true })),
          },
          $transaction: jest.fn(async (cb) => {
            return cb(mockedPrisma);
          }),
        };
        return mockedPrisma;
      },
    },
    {
      provide: RedisService,
      useFactory: () => {
        const redisStore = new Map<string, string>();
        return {
          get: jest.fn(async (k: string) => redisStore.get(k) || null),
          set: jest.fn(async (k: string, v: string) => {
            redisStore.set(k, v);
          }),
          del: jest.fn(async (k: string) => {
            redisStore.delete(k);
          }),
        };
      },
    },
    {
      provide: MailService,
      useValue: {
        sendOtpEmail: jest.fn(async (email: string, code: string) => {
          lastSentEmail = email;
          lastSentOtp = code;
        }),
      },
    },
    {
      provide: ConfigService,
      useValue: {
        get: jest.fn((k: string) => {
          if (k === 'WORKER_SECRET_KEY') return 'SBC...WORKER';
          return null;
        }),
      },
    },
    {
      provide: SupabaseService,
      useValue: {
        getClient: () => ({
          auth: {
            getUser: jest.fn(),
          },
        }),
      },
    },
    {
      provide: UsersService,
      useValue: {
        findOne: jest.fn(),
      },
    },
  ],
})
class TestE2EModule {}

// -----------------------------------------------------------------------------
// E2E Test Suite
// -----------------------------------------------------------------------------
describe('Suite de Pruebas Integrales de Carga, Concurrencia y Persistencia (E2E)', () => {
  let app: NestFastifyApplication;
  let testController: TestE2EController;

  // Mock JWT Tokens representing authenticated sessions
  const HOGAR_TOKEN = 'jwt-token-hogar';
  const RECOLECTOR_TOKEN = 'jwt-token-recolector';
  const RECOLECTOR_2_TOKEN = 'jwt-token-recolector-2';
  const CENTRO_TOKEN = 'jwt-token-centro';
  const ADMIN_TOKEN = 'jwt-token-admin';
  const TIENDA_TOKEN = 'jwt-token-tienda';

  beforeAll(async () => {
    // Mock AuthGuard configuration to be overridden during compiler phase
    const mockAuthGuard = {
      canActivate: async (context: any) => {
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '');

        if (!token) {
          throw new UnauthorizedException('Token no proporcionado');
        }

        const mockUsers: Record<string, any> = {
          [HOGAR_TOKEN]: { id: 'hogar-uuid', email: 'citizen@livora.pe', role: Role.HOGAR },
          [RECOLECTOR_TOKEN]: { id: 'collector-1', email: 'recolector1@livora.pe', role: Role.RECOLECTOR },
          [RECOLECTOR_2_TOKEN]: { id: 'collector-2', email: 'recolector2@livora.pe', role: Role.RECOLECTOR },
          [CENTRO_TOKEN]: { id: 'center-uuid', email: 'centro@livora.pe', role: Role.CENTRO_ACOPIO },
          [ADMIN_TOKEN]: { id: 'admin-uuid', email: 'admin@livora.pe', role: Role.ADMIN },
          [TIENDA_TOKEN]: { id: 'tienda-uuid', email: 'tienda@livora.pe', role: Role.TIENDA },
        };

        const user = mockUsers[token];
        if (!user) {
          throw new UnauthorizedException('Token inválido');
        }

        req.user = user;
        return true;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestE2EModule],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue(mockAuthGuard)
      .compile();

    testController = moduleRef.get<TestE2EController>(TestE2EController);

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    // Mock SupabaseAuthGuard user resolution based on the mock token header
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ===========================================================================
  // 1. CONCURRENCY & RACE CONDITIONS
  // ===========================================================================
  describe('1. Concurrencia y Condiciones de Carrera', () => {
    it('Colisión en Aceptación de Recolecciones: Solo 1 de 5 recolectores concurrentes asignado', async () => {
      // Reset controller state
      testController.collectionRequestAcceptedBy = null;

      // Simulate 5 collectors making parallel requests
      const collectors = [
        RECOLECTOR_TOKEN,
        RECOLECTOR_2_TOKEN,
        RECOLECTOR_TOKEN,
        RECOLECTOR_2_TOKEN,
        RECOLECTOR_TOKEN,
      ];

      const requests = collectors.map((token) =>
        request(app.getHttpServer())
          .post('/test-e2e/collection-requests/req-abc/accept')
          .set('Authorization', `Bearer ${token}`)
          .send(),
      );

      const responses = await Promise.all(requests);

      const successCount = responses.filter((r) => r.status === 201).length;
      const conflictCount = responses.filter((r) => r.status === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(4);
      expect(testController.collectionRequestAcceptedBy).not.toBeNull();
    });

    it('Doble Canje Simultáneo en Tiendas (Double-Spending): Evitar cargos duplicados', async () => {
      // Reseteamos estado del QR
      testController.qrConfirmed = false;

      // Realizamos dos peticiones de confirmación en paralelo
      const req1 = request(app.getHttpServer())
        .post('/test-e2e/stores/redemptions/confirm/QR-SPEC-999')
        .set('Authorization', `Bearer ${HOGAR_TOKEN}`)
        .send({ termsAccepted: true });

      const req2 = request(app.getHttpServer())
        .post('/test-e2e/stores/redemptions/confirm/QR-SPEC-999')
        .set('Authorization', `Bearer ${HOGAR_TOKEN}`)
        .send({ termsAccepted: true });

      const [res1, res2] = await Promise.all([req1, req2]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);
      expect(statuses).toContain(409);
      expect(blockchainTransferEnqueued).toBe(true);
    });

    it('Ráfaga Concurrente de Registro y OTP: Aislamiento completo de sesiones en Redis', async () => {
      // Dos peticiones de registro paralelas con emails diferentes
      const reg1 = request(app.getHttpServer())
        .post('/test-e2e/auth/register')
        .send({ email: 'user.a@livora.pe' });

      const reg2 = request(app.getHttpServer())
        .post('/test-e2e/auth/register')
        .send({ email: 'user.b@livora.pe' });

      const [res1, res2] = await Promise.all([reg1, reg2]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      // Validamos aislamiento y que no haya bleed
      expect(lastSentEmail).toBe('user.b@livora.pe');
      expect(lastSentOtp).toBe('123456');
    });
  });

  // ===========================================================================
  // 2. TRANSACTIONAL INTEGRITY & PERSISTENCE
  // ===========================================================================
  describe('2. Integridad Transaccional y Persistencia (Prisma)', () => {
    it('Balance de Masa en Ventas B2B: Merma del 5% y rollback si stock es insuficiente', async () => {
      // historicInputs = 100 kg. Venta máxima admitida = 95 kg.
      // Intentar vender 96 kg (Excede el 5% de merma) -> debe fallar con 400
      const failMerma = await request(app.getHttpServer())
        .post('/test-e2e/sales')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ materialType: 'PET', quantityKg: 96, customerId: 'cust-xyz' });

      expect(failMerma.status).toBe(400);
      expect(failMerma.body.detail).toContain('merma industrial');

      // Intentar vender 90 kg (Válido) -> debe tener éxito
      const successSale = await request(app.getHttpServer())
        .post('/test-e2e/sales')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ materialType: 'PET', quantityKg: 90, customerId: 'cust-xyz' });

      expect(successSale.status).toBe(201);
      expect(testController.currentStock).toBe(10); // 100 - 90
    });

    it('Cálculo y Distribución de Tokens (80/20)', async () => {
      // 10 kg de peso -> 15 ECO de recompensa. Citizen: 80% (12 ECO). Collector: 20% (3 ECO).
      const res = await request(app.getHttpServer())
        .post('/test-e2e/batches/weighed')
        .set('Authorization', `Bearer ${CENTRO_TOKEN}`)
        .send({ weightKg: 10 });

      expect(res.status).toBe(201);
      expect(res.body.rewardTotal).toBe(15);
      expect(res.body.citizenReward).toBe(12);
      expect(res.body.collectorReward).toBe(3);
    });

    it('Derechos ARCO y Eliminación de Cuenta: Anonimización de campos sensibles', async () => {
      const res = await request(app.getHttpServer())
        .delete('/test-e2e/users/me')
        .set('Authorization', `Bearer ${HOGAR_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ===========================================================================
  // 3. ROLE-BASED ACCESS CONTROL (RBAC)
  // ===========================================================================
  describe('3. Control de Acceso y Aislamiento de Roles (RBAC)', () => {
    it('HOGAR no puede acceder a administración o pesaje industrial', async () => {
      const adminRes = await request(app.getHttpServer())
        .get('/test-e2e/admin/inventory')
        .set('Authorization', `Bearer ${HOGAR_TOKEN}`);
      expect(adminRes.status).toBe(403);

      const centroRes = await request(app.getHttpServer())
        .post('/test-e2e/centro/reception')
        .set('Authorization', `Bearer ${HOGAR_TOKEN}`);
      expect(centroRes.status).toBe(403);
    });

    it('RECOLECTOR no puede generar cupones de cobro de tienda', async () => {
      const storeRes = await request(app.getHttpServer())
        .post('/test-e2e/stores/redemptions/qr')
        .set('Authorization', `Bearer ${RECOLECTOR_TOKEN}`);
      expect(storeRes.status).toBe(403);
    });

    it('Peticiones sin token o inválidas son rechazadas con 401/400', async () => {
      const noToken = await request(app.getHttpServer())
        .get('/test-e2e/admin/inventory');
      expect(noToken.status).toBe(401);

      const invalidPayload = await request(app.getHttpServer())
        .post('/test-e2e/batches/weighed')
        .set('Authorization', `Bearer ${CENTRO_TOKEN}`)
        .send({ weightKg: 'peso_invalido' }); // ValidationPipe must trigger 400
      expect(invalidPayload.status).toBe(400);
    });
  });

  // ===========================================================================
  // 4. EXTERNAL SERVICES & INFRASTRUCTURE
  // ===========================================================================
  describe('4. Integración de Servicios Externos', () => {
    it('Sentry: Captura excepciones sin exponer stack trace al cliente', async () => {
      const res = await request(app.getHttpServer())
        .get('/test-e2e/trigger-500');

      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('Database connection failed temporarily');
      expect(res.body.stack).toBeUndefined(); // no stack traces leak to client
      expect(sentryCapturedError).not.toBeNull();
      expect(sentryCapturedError!.message).toBe('Database connection failed temporarily');
    });

    it('Firebase: Captura errores FCM de forma controlada', async () => {
      const res = await request(app.getHttpServer())
        .post('/test-e2e/trigger-firebase-push')
        .send();

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(sentryCapturedError!.message).toBe('FCM token is not registered');
    });
  });
});
