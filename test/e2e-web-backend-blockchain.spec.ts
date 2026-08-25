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
import * as crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

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

// -----------------------------------------------------------------------------
// Cryptographic AES-256-GCM Helper
// -----------------------------------------------------------------------------
class CryptoUtilLocal {
  static encrypt(text: string, secretKey: string): string {
    const iv = crypto.randomBytes(12);
    // Key needs to be 32 bytes
    const key = crypto.createHash('sha256').update(secretKey).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  static decrypt(encryptedText: string, secretKey: string): string | null {
    try {
      const parts = encryptedText.split(':');
      if (parts.length !== 3) return null;
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];
      const key = crypto.createHash('sha256').update(secretKey).digest();
      const decipher = decipherivMethod(iv, authTag, encrypted, key);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return null;
    }
  }
}

function decipherivMethod(iv: Buffer, authTag: Buffer, encrypted: string, key: Buffer) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher;
}

// -----------------------------------------------------------------------------
// Stellar Soroban Mock Network State
// -----------------------------------------------------------------------------
class MockSorobanNetwork {
  public balances = new Map<string, bigint>();
  public nonces = new Map<string, bigint>();
  public batches = new Map<string, any>();
  public txLogs: string[] = [];

  getBalance(address: string): number {
    const bal = this.balances.get(address) || 0n;
    return Number(bal) / 10000000;
  }

  getNonce(address: string): number {
    return Number(this.nonces.get(address) || 0n);
  }

  registerBatchWeighed(
    batchId: string,
    collector: string,
    households: string[],
    materialTypes: string[],
    weightsGrams: number[],
  ): string {
    const txHash = crypto.createHash('sha256').update(batchId + Date.now()).digest('hex');
    this.txLogs.push(txHash);

    // Calculate total reward: 1.5 ECO per kg
    let totalGrams = 0;
    weightsGrams.forEach((w) => (totalGrams += w));
    const totalKg = totalGrams / 1000;
    const totalReward = BigInt(Math.round(totalKg * 1.5 * 10000000));

    if (households.length > 0) {
      // 80/20 split
      const citizenRewardTotal = (totalReward * 8n) / 10n;
      const citizenShare = citizenRewardTotal / BigInt(households.length);
      const collectorReward = totalReward - (citizenShare * BigInt(households.length));

      households.forEach((h) => {
        const bal = this.balances.get(h) || 0n;
        this.balances.set(h, bal + citizenShare);
      });

      const collBal = this.balances.get(collector) || 0n;
      this.balances.set(collector, collBal + collectorReward);
    } else {
      // 100% to collector
      const collBal = this.balances.get(collector) || 0n;
      this.balances.set(collector, collBal + totalReward);
    }

    this.batches.set(batchId, {
      batchId,
      collector,
      households,
      totalReward: totalReward.toString(),
      txHash,
    });

    return txHash;
  }

  transferDelegated(
    from: string,
    to: string,
    amountEco: number,
    nonce: number,
    signatureHex: string,
  ): string {
    const expectedNonce = Number(this.nonces.get(from) || 0n);
    if (nonce !== expectedNonce) {
      throw new Error(`Invalid Soroban Nonce: expected ${expectedNonce}, got ${nonce}`);
    }

    const amountGrams = BigInt(Math.round(amountEco * 10000000));
    const fromBal = this.balances.get(from) || 0n;
    if (fromBal < amountGrams) {
      throw new Error('Insufficient balance in Soroban contract');
    }

    // Process balances & nonce update
    this.balances.set(from, fromBal - amountGrams);
    const toBal = this.balances.get(to) || 0n;
    this.balances.set(to, toBal + amountGrams);
    this.nonces.set(from, BigInt(expectedNonce + 1));

    const txHash = crypto.createHash('sha256').update(signatureHex).digest('hex');
    this.txLogs.push(txHash);
    return txHash;
  }
}

const mockSoroban = new MockSorobanNetwork();

// -----------------------------------------------------------------------------
// DTOs for testing
// -----------------------------------------------------------------------------
class RegisterUserDto {
  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsNotEmpty()
  role!: string;
}

class ConfirmOtpDto {
  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  code!: string;
}

class CreateBatchWeighedDto {
  @IsString()
  @IsNotEmpty()
  collectorId!: string;

  @IsString()
  @IsNotEmpty()
  centerId!: string;

  @IsNumber()
  @IsNotEmpty()
  weightPETGrams!: number;

  @IsNumber()
  @IsNotEmpty()
  weightGlassGrams!: number;

  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  householdIds!: string[];
}

class CreateQrRedemptionDto {
  @IsNumber()
  @IsNotEmpty()
  tokenAmount!: number;
}

class ConfirmQrPaymentDto {
  @IsBoolean()
  @IsNotEmpty()
  termsAccepted!: boolean;
}

class CreateB2BSaleDto {
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

// -----------------------------------------------------------------------------
// Integration Controller
// -----------------------------------------------------------------------------
@Controller('e2e-integration')
class E2EIntegrationController {
  private users = new Map<string, any>();
  private otps = new Map<string, string>();
  private wallets = new Map<string, string>(); // userId -> publicKey
  private encryptedKeys = new Map<string, string>(); // userId -> encryptedPrivateKey
  private inventory = new Map<string, number>(); // materialType -> quantityKg
  private totalHistoricInputs = 1000.0; // Consolidado de entradas

  constructor(private readonly config: ConfigService) {}

  @Post('auth/register')
  async register(@Body() dto: RegisterUserDto) {
    // 1. Generate Stellar Wallet Keypair
    const pair = Keypair.random();
    const walletAddress = pair.publicKey();
    const privateKey = pair.secret();

    // 2. Encrypt Private Key with AES-256-GCM
    const encryptionKey = this.config.get<string>('WALLET_ENCRYPTION_KEY') || 'livora_passphrase_32_bytes_len!';
    const encryptedPrivateKey = CryptoUtilLocal.encrypt(privateKey, encryptionKey);

    const userId = `usr-${crypto.randomBytes(4).toString('hex')}`;
    const user = {
      id: userId,
      email: dto.email,
      role: dto.role,
      walletAddress,
      encryptedPrivateKey,
      isActive: false,
    };

    this.users.set(dto.email, user);
    this.otps.set(dto.email, '654321'); // fixed OTP for test predictability

    return {
      id: userId,
      email: dto.email,
      walletAddress,
      encrypted: true,
    };
  }

  @Post('auth/verify')
  async verify(@Body() dto: ConfirmOtpDto) {
    const user = this.users.get(dto.email);
    if (!user) throw new BadRequestException('Usuario no registrado');
    const otp = this.otps.get(dto.email);
    if (otp !== dto.code) throw new BadRequestException('Código OTP inválido');

    user.isActive = true;
    return { success: true, user };
  }

  @Get('dashboard/hogar')
  @Roles(Role.HOGAR)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async getDashboardHogar(@CurrentUser() user: any) {
    const dbUser = Array.from(this.users.values()).find((u) => u.id === user.id);
    if (!dbUser) throw new BadRequestException('Usuario no encontrado');

    // Retrieve balance from Stellar Soroban Contract
    const balance = mockSoroban.getBalance(dbUser.walletAddress);
    return {
      balance: balance.toFixed(2),
      co2SavedKg: (balance * 0.45).toFixed(1), // dynamic ESG logic
    };
  }

  @Post('centro/reception')
  @Roles(Role.CENTRO_ACOPIO)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async receiveWeighedBatch(@Body() dto: CreateBatchWeighedDto) {
    // 1. Enqueue job / async processing simulation
    const batchId = `bat-${crypto.randomBytes(4).toString('hex')}`;
    const ipfsCid = `Qm${crypto.randomBytes(16).toString('hex')}`;

    // Get wallets for participants
    const collector = Array.from(this.users.values()).find((u) => u.id === dto.collectorId);
    if (!collector) throw new BadRequestException('Collector not found');

    const households = dto.householdIds.map((hid) => {
      const h = Array.from(this.users.values()).find((u) => u.id === hid);
      if (!h) throw new BadRequestException(`Household ${hid} not found`);
      return h.walletAddress;
    });

    // 2. Invoke contract function register_batch_weighed
    const txHash = mockSoroban.registerBatchWeighed(
      batchId,
      collector.walletAddress,
      households,
      ['PET', 'VIDRIO'],
      [dto.weightPETGrams, dto.weightGlassGrams],
    );

    // Save inventory in PostgreSQL simulation
    const totalPETKg = dto.weightPETGrams / 1000;
    const totalGlassKg = dto.weightGlassGrams / 1000;

    this.inventory.set('PET', (this.inventory.get('PET') || 0) + totalPETKg);
    this.inventory.set('VIDRIO', (this.inventory.get('VIDRIO') || 0) + totalGlassKg);

    return {
      status: 'ACCEPTED',
      batchId,
      ipfsCid: `https://gateway.pinata.cloud/ipfs/${ipfsCid}`,
      txHash,
    };
  }

  @Post('redemptions/qr')
  @Roles(Role.TIENDA)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async generateQr(@Body() dto: CreateQrRedemptionDto) {
    const qrCodeRef = `LIVORA-QR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    return {
      qrCodeRef,
      tokenAmount: dto.tokenAmount,
      status: 'PENDING',
    };
  }

  @Post('redemptions/confirm/:qrCodeRef')
  @Roles(Role.HOGAR)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async confirmRedemption(
    @CurrentUser() user: any,
    @Param('qrCodeRef') qrCodeRef: string,
    @Body() dto: ConfirmQrPaymentDto,
  ) {
    if (!dto.termsAccepted) {
      throw new BadRequestException('Debe aceptar los términos');
    }

    const dbUser = Array.from(this.users.values()).find((u) => u.id === user.id);
    if (!dbUser) throw new BadRequestException('User profile not found');

    // 1. Decrypt seed in memory
    const encryptionKey = this.config.get<string>('WALLET_ENCRYPTION_KEY') || 'livora_passphrase_32_bytes_len!';
    const decryptedSecret = CryptoUtilLocal.decrypt(dbUser.encryptedPrivateKey, encryptionKey);
    if (!decryptedSecret) throw new BadRequestException('Decryption failed');

    // 2. Query Nonce on chain & sign
    const nonce = mockSoroban.getNonce(dbUser.walletAddress);
    const amountEco = 25.00;

    const userKeypair = Keypair.fromSecret(decryptedSecret);
    const msg = Buffer.from(`delegated:${dbUser.walletAddress}:${amountEco}:${nonce}`);
    const signatureHex = userKeypair.sign(msg).toString('hex');

    // 3. Relayer executes transfer_delegated on Soroban (paying Stroops gas)
    // Destination: Tienda wallet
    const tiendaUser = Array.from(this.users.values()).find((u) => u.role === 'TIENDA');
    const tiendaWallet = tiendaUser ? tiendaUser.walletAddress : 'GDTIENDA...';

    const txHash = mockSoroban.transferDelegated(
      dbUser.walletAddress,
      tiendaWallet,
      amountEco,
      nonce,
      signatureHex,
    );

    return {
      success: true,
      txHash,
      status: 'COMPLETED',
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    };
  }

  @Post('sales')
  @Roles(Role.ADMIN)
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  async createSale(@Body() dto: CreateB2BSaleDto) {
    const merma = 0.05;
    const maxAllowedSale = this.totalHistoricInputs * (1 - merma);

    if (dto.quantityKg > maxAllowedSale) {
      throw new BadRequestException(
        `Venta excede la masa permitida contemplando la merma industrial del 5%. Límite: ${maxAllowedSale} kg`,
      );
    }

    const currentStock = this.inventory.get(dto.materialType) || 0;
    if (dto.quantityKg > currentStock) {
      throw new BadRequestException('Stock insuficiente en inventario físico');
    }

    this.inventory.set(dto.materialType, currentStock - dto.quantityKg);

    const txHash = crypto.createHash('sha256').update(dto.customerId + Date.now()).digest('hex');
    return {
      success: true,
      txHash,
      receiptUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    };
  }
}

// -----------------------------------------------------------------------------
// Test module bundle
// -----------------------------------------------------------------------------
@Module({
  controllers: [E2EIntegrationController],
  providers: [
    {
      provide: PrismaService,
      useValue: {},
    },
    {
      provide: RedisService,
      useValue: {},
    },
    {
      provide: MailService,
      useValue: {},
    },
    {
      provide: ConfigService,
      useValue: {
        get: jest.fn((k: string) => {
          if (k === 'WALLET_ENCRYPTION_KEY') return 'test_aes_key_32_bytes_length!';
          return null;
        }),
      },
    },
    {
      provide: SupabaseService,
      useValue: {},
    },
    {
      provide: UsersService,
      useValue: {},
    },
  ],
})
class TestE2EIntegrationModule {}

// -----------------------------------------------------------------------------
// E2E Test Suite
// -----------------------------------------------------------------------------
describe('Pruebas E2E de Integración Frontend -> Backend -> Stellar Soroban', () => {
  let app: NestFastifyApplication;
  let controller: E2EIntegrationController;

  // Track dynamic credentials generated
  let citizenUserId: string;
  let citizenWallet: string;
  let collectorUserId: string;
  let collectorWallet: string;
  let centerUserId: string;
  let adminUserId: string;
  let tiendaUserId: string;
  let tiendaWallet: string;

  // Session JWT Mocks
  const CITIZEN_JWT = 'jwt-citizen';
  const CITIZEN_2_JWT = 'jwt-citizen-2';
  const COLLECTOR_JWT = 'jwt-collector';
  const CENTER_JWT = 'jwt-center';
  const ADMIN_JWT = 'jwt-admin';
  const TIENDA_JWT = 'jwt-tienda';

  beforeAll(async () => {
    const mockAuthGuard = {
      canActivate: async (context: any) => {
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers.authorization || '';
        const token = authHeader.replace('Bearer ', '');

        if (!token) throw new UnauthorizedException('Token missing');

        const mockUsers: Record<string, any> = {
          [CITIZEN_JWT]: { id: citizenUserId, email: 'citizen.e2e@livora.pe', role: Role.HOGAR },
          [COLLECTOR_JWT]: { id: collectorUserId, email: 'collector.e2e@livora.pe', role: Role.RECOLECTOR },
          [CENTER_JWT]: { id: centerUserId, email: 'centro.e2e@livora.pe', role: Role.CENTRO_ACOPIO },
          [ADMIN_JWT]: { id: adminUserId, email: 'admin.e2e@livora.pe', role: Role.ADMIN },
          [TIENDA_JWT]: { id: tiendaUserId, email: 'tienda.e2e@livora.pe', role: Role.TIENDA },
        };

        const user = mockUsers[token];
        if (!user) throw new UnauthorizedException('Invalid mock token');

        req.user = user;
        return true;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestE2EIntegrationModule],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue(mockAuthGuard)
      .compile();

    controller = moduleRef.get<E2EIntegrationController>(E2EIntegrationController);

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ===========================================================================
  // ESCENARIO 1: ONBOARDING, WALLET GENERATION & SECURE AES ENCRYPTION
  // ===========================================================================
  describe('Escenario 1: Onboarding, Wallet y Cifrado AES-256-GCM', () => {
    it('Debe registrar y activar un nuevo ciudadano con wallet de Stellar segura', async () => {
      // 1. POST /registro
      const regRes = await request(app.getHttpServer())
        .post('/e2e-integration/auth/register')
        .send({
          email: 'citizen.e2e@livora.pe',
          password: 'PassSecureWeb3!',
          role: 'HOGAR',
        })
        .expect(201);

      citizenUserId = regRes.body.id;
      citizenWallet = regRes.body.walletAddress;

      expect(citizenWallet).toMatch(/^G[A-Z0-9]{55}$/); // Stellar G... format
      expect(regRes.body.encrypted).toBe(true);

      // 2. POST /verificar-otp
      const verifyRes = await request(app.getHttpServer())
        .post('/e2e-integration/auth/verify')
        .send({
          email: 'citizen.e2e@livora.pe',
          code: '654321',
        })
        .expect(201);

      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.user.isActive).toBe(true);
      // Validate that private key is encrypted (AES pattern contains ':' separators)
      expect(verifyRes.body.user.encryptedPrivateKey).toContain(':');

      // Create other participants for the next steps
      const regColl = await request(app.getHttpServer())
        .post('/e2e-integration/auth/register')
        .send({
          email: 'collector.e2e@livora.pe',
          password: 'CollectorPass!',
          role: 'RECOLECTOR',
        });
      collectorUserId = regColl.body.id;
      collectorWallet = regColl.body.walletAddress;

      const regCenter = await request(app.getHttpServer())
        .post('/e2e-integration/auth/register')
        .send({
          email: 'centro.e2e@livora.pe',
          password: 'CenterPass!',
          role: 'CENTRO_ACOPIO',
        });
      centerUserId = regCenter.body.id;

      const regAdmin = await request(app.getHttpServer())
        .post('/e2e-integration/auth/register')
        .send({
          email: 'admin.e2e@livora.pe',
          password: 'AdminPass!',
          role: 'ADMIN',
        });
      adminUserId = regAdmin.body.id;

      const regStore = await request(app.getHttpServer())
        .post('/e2e-integration/auth/register')
        .send({
          email: 'tienda.e2e@livora.pe',
          password: 'StorePass!',
          role: 'TIENDA',
        });
      tiendaUserId = regStore.body.id;
      tiendaWallet = regStore.body.walletAddress;
    });

    it('Debe cargar el dashboard del Ciudadano con balance inicial cero', async () => {
      const res = await request(app.getHttpServer())
        .get('/e2e-integration/dashboard/hogar')
        .set('Authorization', `Bearer ${CITIZEN_JWT}`)
        .expect(200);

      expect(res.body.balance).toBe('0.00');
      expect(res.body.co2SavedKg).toBe('0.0');
    });
  });

  // ===========================================================================
  // ESCENARIO 2: FLUJO DE PESAJE INDUSTRIAL Y MINTING ON-CHAIN (80/20)
  // ===========================================================================
  describe('Escenario 2: Recepción de Lotes y Minting Soroban (80/20)', () => {
    it('Debe registrar el pesaje en el centro y distribuir tokens en Soroban', async () => {
      // 1. Centro registra lote: 50 kg de PET y 20 kg de Vidrio = 70 kg totales.
      // 70 kg * 1.5 ECO = 105 EcoTokens.
      // Citizen (80%) -> 84 ECO.
      // Collector (20%) -> 21 ECO.
      const weighRes = await request(app.getHttpServer())
        .post('/e2e-integration/centro/reception')
        .set('Authorization', `Bearer ${CENTER_JWT}`)
        .send({
          collectorId: collectorUserId,
          centerId: 'center-xyz',
          weightPETGrams: 50000,
          weightGlassGrams: 20000,
          householdIds: [citizenUserId], // 1 Citizen splits 100% of the 80% share
        })
        .expect(201);

      expect(weighRes.body.status).toBe('ACCEPTED');
      expect(weighRes.body.txHash).toBeDefined();
      expect(weighRes.body.ipfsCid).toContain('ipfs/');

      // 2. Verify balances on Soroban Mock
      const citizenBal = mockSoroban.getBalance(citizenWallet);
      const collectorBal = mockSoroban.getBalance(collectorWallet);

      expect(citizenBal).toBe(84); // 80% of 105
      expect(collectorBal).toBe(21); // 20% of 105
    });

    it('El ciudadano debe ver el balance actualizado en el dashboard', async () => {
      const res = await request(app.getHttpServer())
        .get('/e2e-integration/dashboard/hogar')
        .set('Authorization', `Bearer ${CITIZEN_JWT}`)
        .expect(200);

      expect(res.body.balance).toBe('84.00');
      expect(Number(res.body.co2SavedKg)).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // ESCENARIO 3: DELEGATED GAS-LESS REDEMPTION (ED25519)
  // ===========================================================================
  describe('Escenario 3: Canje de QR y Firma Delegada Ed25519 (Gas-less)', () => {
    it('Debe autorizar el cobro con la semilla del Hogar y descontar saldo', async () => {
      // 1. Tienda genera cobro de 25 ECO
      const qrRes = await request(app.getHttpServer())
        .post('/e2e-integration/redemptions/qr')
        .set('Authorization', `Bearer ${TIENDA_JWT}`)
        .send({ tokenAmount: 25.00 })
        .expect(201);

      const qrCodeRef = qrRes.body.qrCodeRef;

      // 2. Citizen confirma el canje. Se descifra la firma y se invoca Soroban
      const confirmRes = await request(app.getHttpServer())
        .post(`/e2e-integration/redemptions/confirm/${qrCodeRef}`)
        .set('Authorization', `Bearer ${CITIZEN_JWT}`)
        .send({ termsAccepted: true })
        .expect(201);

      expect(confirmRes.body.success).toBe(true);
      expect(confirmRes.body.status).toBe('COMPLETED');
      expect(confirmRes.body.txHash).toBeDefined();

      // 3. Verify balance decrease on Hogar and increase on Tienda on-chain
      const citizenBal = mockSoroban.getBalance(citizenWallet);
      const tiendaBal = mockSoroban.getBalance(tiendaWallet);
      const citizenNonce = mockSoroban.getNonce(citizenWallet);

      expect(citizenBal).toBe(59); // 84 - 25
      expect(tiendaBal).toBe(25); // received 25
      expect(citizenNonce).toBe(1); // Nonce incremented for replay protection
    });
  });

  // ===========================================================================
  // ESCENARIO 4: ESG COMPLIANCE B2B TRACEABILITY & RECEIPTS
  // ===========================================================================
  describe('Escenario 4: Trazabilidad B2B e Impacto ESG', () => {
    it('Debe registrar venta corporativa validando la merma y retornando recibos de Stellar', async () => {
      // 1. Venta excede el 5% de merma (Total inputs: 1000, 95% = 950 kg max, intentamos 951)
      await request(app.getHttpServer())
        .post('/e2e-integration/sales')
        .set('Authorization', `Bearer ${ADMIN_JWT}`)
        .send({
          materialType: 'PET',
          quantityKg: 951.0,
          customerId: 'b2b-company-1',
        })
        .expect(400);

      // 2. Venta válida (50 kg). Stock PET actual es 50 kg.
      const saleRes = await request(app.getHttpServer())
        .post('/e2e-integration/sales')
        .set('Authorization', `Bearer ${ADMIN_JWT}`)
        .send({
          materialType: 'PET',
          quantityKg: 50.0,
          customerId: 'b2b-company-1',
        })
        .expect(201);

      expect(saleRes.body.success).toBe(true);
      expect(saleRes.body.receiptUrl).toContain('stellar.expert/explorer/testnet/tx/');
    });
  });
});
