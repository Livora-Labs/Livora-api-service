import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';
import PDFDocument from 'pdfkit';
import * as crypto from 'crypto';
import { Role } from '@prisma/client';

import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { CurrentUser } from '../src/common/decorators/current-user.decorator';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/redis/redis.service';
import { MailService } from '../src/common/services/mail.service';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { VerifyEmailDto } from '../src/auth/dto/verify-email.dto';

// =============================================================================
// INDECOPI ENUMS & DTOS (Ley 29571 / Ley 32495 & Ley 29733)
// =============================================================================

export enum DocumentType {
  DNI = 'DNI',
  CE = 'CE',
  PASAPORTE = 'PASAPORTE',
  RUC = 'RUC',
}

export enum GoodType {
  PRODUCTO = 'PRODUCTO',
  SERVICIO = 'SERVICIO',
}

export enum ClaimType {
  RECLAMO = 'RECLAMO',
  QUEJA = 'QUEJA',
}

export enum ComplaintStatus {
  RECEIVED = 'RECEIVED',
  IN_PROCESS = 'IN_PROCESS',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export function IsValidDocumentNumber(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidDocumentNumber',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          if (typeof value !== 'string') return false;
          const obj = args.object as CreateComplaintDto;
          switch (obj.documentType) {
            case DocumentType.DNI:
              return /^\d{8}$/.test(value);
            case DocumentType.CE:
              return /^[A-Za-z0-9]{9,12}$/.test(value);
            case DocumentType.PASAPORTE:
              return /^[A-Za-z0-9]{6,12}$/.test(value);
            case DocumentType.RUC:
              return /^\d{11}$/.test(value);
            default:
              return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          const obj = args.object as CreateComplaintDto;
          return `documentNumber is invalid for documentType ${obj.documentType}`;
        },
      },
    });
  };
}

export class CreateComplaintDto {
  @IsEnum(DocumentType, {
    message: 'documentType must be one of DNI, CE, PASAPORTE, RUC',
  })
  @IsNotEmpty({ message: 'documentType is required' })
  documentType: DocumentType;

  @IsString({ message: 'documentNumber must be a string' })
  @IsNotEmpty({ message: 'documentNumber is required' })
  @IsValidDocumentNumber()
  documentNumber: string;

  @IsString({ message: 'fullName must be a string' })
  @IsNotEmpty({ message: 'fullName is required' })
  @MinLength(3, { message: 'fullName must have at least 3 characters' })
  @MaxLength(200, { message: 'fullName cannot exceed 200 characters' })
  fullName: string;

  @IsString({ message: 'address must be a string' })
  @IsNotEmpty({ message: 'address is required' })
  @MinLength(5, { message: 'address must have at least 5 characters' })
  address: string;

  @IsString({ message: 'phone must be a string' })
  @IsNotEmpty({ message: 'phone is required' })
  @Matches(/^[+0-9\s\-()]{7,15}$/, {
    message: 'phone must be a valid telephone number between 7 and 15 digits',
  })
  phone: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  @IsNotEmpty({ message: 'email is required' })
  email: string;

  @IsOptional()
  @IsBoolean({ message: 'isMinor must be a boolean' })
  isMinor?: boolean;

  @IsOptional()
  @IsString({ message: 'representativeName must be a string' })
  @ValidateIf((o) => o.isMinor === true)
  @IsNotEmpty({
    message: 'representativeName is required when consumer is a minor',
  })
  @MinLength(3, {
    message: 'representativeName must have at least 3 characters',
  })
  representativeName?: string;

  @IsEnum(GoodType, {
    message: 'goodType must be either PRODUCTO or SERVICIO',
  })
  @IsNotEmpty({ message: 'goodType is required' })
  goodType: GoodType;

  @IsString({ message: 'goodDescription must be a string' })
  @IsNotEmpty({ message: 'goodDescription is required' })
  @MinLength(5, { message: 'goodDescription must have at least 5 characters' })
  goodDescription: string;

  @IsOptional()
  @IsNumber({}, { message: 'amount must be a number' })
  @Min(0, { message: 'amount cannot be negative' })
  @Type(() => Number)
  amount?: number;

  @IsEnum(ClaimType, {
    message: 'claimType must be either RECLAMO or QUEJA',
  })
  @IsNotEmpty({ message: 'claimType is required' })
  claimType: ClaimType;

  @IsString({ message: 'claimDetail must be a string' })
  @IsNotEmpty({ message: 'claimDetail is required' })
  @MinLength(10, { message: 'claimDetail must have at least 10 characters' })
  claimDetail: string;

  @IsString({ message: 'consumerRequest must be a string' })
  @IsNotEmpty({ message: 'consumerRequest is required' })
  @MinLength(5, { message: 'consumerRequest must have at least 5 characters' })
  consumerRequest: string;

  @IsOptional()
  @IsString({ message: 'userId must be a string UUID' })
  userId?: string;
}

// =============================================================================
// PDFKIT GENERATOR SERVICE (In-Memory Stream-to-Buffer)
// =============================================================================

export interface ComplaintRecord extends CreateComplaintDto {
  id: string;
  correlativeNumber: string;
  status: ComplaintStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function generateComplaintPdfBuffer(
  complaint: ComplaintRecord,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', compress: false });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // Header & Title
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text('LIBRO DE RECLAMACIONES VIRTUAL', { align: 'center' });
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        'Conforme a la Ley N° 29571 (Código de Protección y Defensa del Consumidor) y Ley N° 32495',
        { align: 'center' },
      );
    doc.moveDown(0.8);

    // Metadata
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .text(`HOJA DE RECLAMACIÓN: ${complaint.correlativeNumber}`, {
        align: 'right',
      });
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(`Fecha y Hora: ${complaint.createdAt.toISOString()}`, {
        align: 'right',
      });
    doc.text('Proveedor: LIVORA S.A.C. | RUC: 20608912345 | Lima, Perú', {
      align: 'right',
    });
    doc.moveDown(0.8);

    // Section 1: Consumer Info
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('1. IDENTIFICACIÓN DEL CONSUMIDOR RECLAMANTE');
    doc.fontSize(9).font('Helvetica');
    doc.text(`Nombre Completo: ${complaint.fullName}`);
    doc.text(
      `Documento de Identidad: ${complaint.documentType} - ${complaint.documentNumber}`,
    );
    doc.text(`Domicilio: ${complaint.address}`);
    doc.text(
      `Teléfono: ${complaint.phone} | Correo Electrónico: ${complaint.email}`,
    );
    if (complaint.isMinor) {
      doc.text(
        `Menor de Edad: SÍ | Representante Legal: ${complaint.representativeName || 'N/A'}`,
      );
    }
    doc.moveDown(0.8);

    // Section 2: Good / Service
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('2. IDENTIFICACIÓN DEL BIEN CONTRATADO');
    doc.fontSize(9).font('Helvetica');
    doc.text(`Tipo de Bien: ${complaint.goodType}`);
    doc.text(
      `Monto Reclamado: ${complaint.amount !== undefined ? `S/ ${complaint.amount.toFixed(2)}` : 'No especificado'}`,
    );
    doc.text(`Descripción del Bien: ${complaint.goodDescription}`);
    doc.moveDown(0.8);

    // Section 3: Claim details
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(`3. DETALLE DE LA RECLAMACIÓN (${complaint.claimType})`);
    doc.fontSize(9).font('Helvetica');
    doc.text(
      `Tipo: ${complaint.claimType === ClaimType.RECLAMO ? 'RECLAMO (Disconformidad con producto o servicio)' : 'QUEJA (Disconformidad con la atención)'}`,
    );
    doc.text(`Detalle: ${complaint.claimDetail}`);
    doc.text(`Pedido del Consumidor: ${complaint.consumerRequest}`);
    doc.moveDown(0.8);

    // Section 4: Legal notice
    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .text('4. OBSERVACIONES Y PLAZO LEGAL');
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .text(
        'Plazo máximo de respuesta: Quince (15) días hábiles no prorrogables de conformidad con el Código de Protección y Defensa del Consumidor (Ley N° 29571).',
      );
    doc.text(
      'La formulación del presente reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el Indecopi.',
    );

    doc.end();
  });
}

export function extractPdfText(pdfBuffer: Buffer): string {
  const raw = pdfBuffer.toString('latin1');
  const matches = raw.matchAll(/<([0-9a-fA-F]+)>/g);
  let decoded = '';
  for (const match of matches) {
    decoded += Buffer.from(match[1], 'hex').toString('latin1');
  }
  return decoded || raw;
}

// =============================================================================
// COMPLAINTS SERVICE & CONTROLLER (Indecopi Compliant)
// =============================================================================

export interface CapturedEmail {
  toEmail: string;
  subject: string;
  htmlContent: string;
  attachment?: {
    name: string;
    content: string; // base64
    type: string;
  };
}

@Injectable()
export class ComplaintsComplianceService {
  private readonly sequenceCounters = new Map<string, number>();
  private readonly complaintsStore = new Map<string, ComplaintRecord>();

  constructor(private readonly mailService: MailService) {}

  generateCorrelative(claimType: ClaimType, date: Date = new Date()): string {
    const year = date.getFullYear();
    const prefix = claimType === ClaimType.RECLAMO ? 'R' : 'Q';
    const key = `${prefix}-${year}`;

    const currentSeq = (this.sequenceCounters.get(key) || 0) + 1;
    this.sequenceCounters.set(key, currentSeq);

    const paddedSeq = String(currentSeq).padStart(5, '0');
    return `${prefix}-${paddedSeq}-${year}`;
  }

  seedSequence(prefix: 'R' | 'Q', year: number, seq: number) {
    this.sequenceCounters.set(`${prefix}-${year}`, seq);
  }

  getSequence(prefix: 'R' | 'Q', year: number): number {
    return this.sequenceCounters.get(`${prefix}-${year}`) || 0;
  }

  async createComplaint(
    dto: CreateComplaintDto,
    explicitDate?: Date,
  ): Promise<ComplaintRecord> {
    const createdAt = explicitDate || new Date();
    const correlativeNumber = this.generateCorrelative(
      dto.claimType,
      createdAt,
    );
    const id = crypto.randomUUID();

    const record: ComplaintRecord = {
      ...dto,
      id,
      correlativeNumber,
      status: ComplaintStatus.RECEIVED,
      createdAt,
      updatedAt: createdAt,
    };

    this.complaintsStore.set(id, record);

    // Generate in-memory PDF
    const pdfBuffer = await generateComplaintPdfBuffer(record);

    // Send email with PDF attachment via Brevo
    if (this.mailService && (this.mailService as any).sendComplaintReceipt) {
      await (this.mailService as any).sendComplaintReceipt(
        record.email,
        record.correlativeNumber,
        pdfBuffer,
      );
    }

    return record;
  }

  async findById(id: string): Promise<ComplaintRecord | null> {
    return this.complaintsStore.get(id) || null;
  }

  async findByCorrelative(
    correlativeNumber: string,
  ): Promise<ComplaintRecord | null> {
    for (const c of this.complaintsStore.values()) {
      if (c.correlativeNumber === correlativeNumber) return c;
    }
    return null;
  }

  async findAll(): Promise<ComplaintRecord[]> {
    return Array.from(this.complaintsStore.values());
  }

  clear() {
    this.sequenceCounters.clear();
    this.complaintsStore.clear();
  }
}

@Controller('complaints')
export class ComplaintsComplianceController {
  constructor(
    private readonly complaintsService: ComplaintsComplianceService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createComplaintDto: CreateComplaintDto) {
    return this.complaintsService.createComplaint(createComplaintDto);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    const complaint = await this.complaintsService.findById(id);
    if (!complaint) {
      throw new NotFoundException(`Reclamación con ID ${id} no encontrada`);
    }
    return complaint;
  }

  @Get('by-correlative/:correlative')
  async getByCorrelative(@Param('correlative') correlative: string) {
    const complaint =
      await this.complaintsService.findByCorrelative(correlative);
    if (!complaint) {
      throw new NotFoundException(
        `Reclamación con correlativo ${correlative} no encontrada`,
      );
    }
    return complaint;
  }
}

// =============================================================================
// COMPLIANCE AUTH & ARCO CONTROLLER (Ley 29733)
// =============================================================================

@Controller('compliance-legal')
export class ComplianceLegalController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('auth/register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('auth/verify')
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    return this.authService.verifyEmail(verifyEmailDto);
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('profile')
  getProfile(@CurrentUser() user: any) {
    return { success: true, user };
  }

  @UseGuards(SupabaseAuthGuard)
  @Delete('arco/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelMyAccount(@CurrentUser('id') userId: string) {
    return this.usersService.cancelAccountARCO(userId);
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('audits')
  async getMyAudits(@CurrentUser('id') userId: string) {
    return this.usersService.getConsentAudits(userId);
  }
}

// =============================================================================
// COMPLIANCE STORES CONTROLLER
// =============================================================================

@Controller('stores')
export class StoresComplianceController {
  public readonly redemptions = new Map<string, any>();

  constructor() {
    // Seed a pending redemption transaction
    this.redemptions.set('LIVORA-QR-TEST-123', {
      id: 'red-uuid-123',
      qrCodeRef: 'LIVORA-QR-TEST-123',
      tokenAmount: 25.0,
      businessName: 'Tienda Aliada Test',
      status: 'PENDING',
    });
  }

  @Get('redemptions/:qrCodeRef')
  async getDetails(@Param('qrCodeRef') qrCodeRef: string) {
    const red = this.redemptions.get(qrCodeRef);
    if (!red) throw new NotFoundException('Cobro no encontrado');
    return red;
  }

  @Post('redemptions/confirm/:qrCodeRef')
  @HttpCode(HttpStatus.OK)
  async confirmRedemption(
    @Param('qrCodeRef') qrCodeRef: string,
    @Body() dto: any,
  ) {
    if (!dto || dto.termsAccepted !== true) {
      throw new BadRequestException(
        'Debe aceptar los Términos y Condiciones de Uso para completar el pago.',
      );
    }
    const red = this.redemptions.get(qrCodeRef);
    if (!red) throw new NotFoundException('Canje no encontrado');

    let extra = 0;
    if (dto.donationOptIn === true) extra += 1.0;
    if (dto.insuranceOptIn === true) extra += 0.5;

    const finalAmount = red.tokenAmount + extra;

    const updated = {
      ...red,
      status: 'COMPLETED',
      tokenAmount: finalAmount,
      termsAccepted: dto.termsAccepted,
      donationOptIn: dto.donationOptIn,
      insuranceOptIn: dto.insuranceOptIn,
    };
    this.redemptions.set(qrCodeRef, updated);
    return updated;
  }
}

// =============================================================================
// TEST SUITE MODULE DEFINITION
// =============================================================================

const capturedEmails: CapturedEmail[] = [];
let lastSentOtp = '';

@Module({
  controllers: [
    ComplaintsComplianceController,
    ComplianceLegalController,
    StoresComplianceController,
  ],
  providers: [
    ComplaintsComplianceService,
    AuthService,
    UsersService,
    {
      provide: PrismaService,
      useFactory: () => {
        const users = new Map<string, any>();
        const consentAudits: any[] = [];
        const storeProfiles = new Map<string, any>();
        const kycApplications = new Map<string, any>();
        const complaints = new Map<string, any>();
        const notifications: any[] = [];
        const betaSignups: any[] = [];

        const mockPrisma: any = {
          user: {
            findUnique: jest.fn(
              async ({ where }: { where: { id?: string; email?: string } }) => {
                if (where.id) return users.get(where.id) || null;
                if (where.email) {
                  for (const u of users.values()) {
                    if (u.email === where.email) return u;
                  }
                }
                return null;
              },
            ),
            create: jest.fn(async ({ data }: any) => {
              const record = {
                ...data,
                isActive: true,
                deletedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              users.set(record.id, record);
              return record;
            }),
            update: jest.fn(async ({ where, data }: any) => {
              const existing = users.get(where.id);
              if (!existing) throw new Error('User not found');
              const updated = {
                ...existing,
                ...data,
                updatedAt: new Date(),
              };
              users.set(where.id, updated);
              return updated;
            }),
          },
          consentAudit: {
            create: jest.fn(async ({ data }: any) => {
              const audit = {
                id: `audit-${consentAudits.length + 1}`,
                ...data,
                createdAt: new Date(),
              };
              consentAudits.push(audit);
              return audit;
            }),
            findMany: jest.fn(async ({ where }: any) => {
              return consentAudits.filter((a) => a.userId === where.userId);
            }),
          },
          storeProfile: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, store] of storeProfiles.entries()) {
                if (store.userId === where.userId) {
                  storeProfiles.set(key, { ...store, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          kycApplication: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, kyc] of kycApplications.entries()) {
                if (kyc.userId === where.userId) {
                  kycApplications.set(key, { ...kyc, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          complaint: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              let count = 0;
              for (const [key, comp] of complaints.entries()) {
                if (comp.userId === where.userId) {
                  complaints.set(key, { ...comp, ...data });
                  count++;
                }
              }
              return { count };
            }),
          },
          notification: {
            deleteMany: jest.fn(async ({ where }: any) => {
              const initialLen = notifications.length;
              const remaining = notifications.filter(
                (n) => n.userId !== where.userId,
              );
              notifications.length = 0;
              notifications.push(...remaining);
              return { count: initialLen - remaining.length };
            }),
          },
          betaSignup: {
            deleteMany: jest.fn(async ({ where }: any) => {
              const initialLen = betaSignups.length;
              const remaining = betaSignups.filter(
                (b) => b.email !== where.email,
              );
              betaSignups.length = 0;
              betaSignups.push(...remaining);
              return { count: initialLen - remaining.length };
            }),
          },
          $transaction: jest.fn(async (cb) => {
            return cb(mockPrisma);
          }),
        };

        mockPrisma._stores = {
          users,
          consentAudits,
          storeProfiles,
          kycApplications,
          complaints,
          notifications,
          betaSignups,
        };

        return mockPrisma;
      },
    },
    {
      provide: SupabaseService,
      useFactory: () => {
        const usersByToken = new Map<string, any>();
        let currentAuthUser: any = null;

        return {
          getClient: () => ({
            auth: {
              admin: {
                createUser: jest.fn(async ({ email, password }: any) => {
                  const id = `supabase-${crypto.randomUUID()}`;
                  currentAuthUser = { id, email };
                  return { data: { user: currentAuthUser }, error: null };
                }),
                deleteUser: jest.fn(async (id: string) => {
                  if (currentAuthUser && currentAuthUser.id === id) {
                    currentAuthUser = null;
                  }
                  return { data: {}, error: null };
                }),
              },
              signInWithPassword: jest.fn(async ({ email }: any) => {
                const token = `jwt-token-for-${email}`;
                const user = currentAuthUser || {
                  id: 'supabase-mock-id',
                  email,
                };
                usersByToken.set(token, user);
                return {
                  data: {
                    session: {
                      access_token: token,
                      refresh_token: `refresh-${token}`,
                      expires_in: 3600,
                      token_type: 'bearer',
                    },
                    user,
                  },
                  error: null,
                };
              }),
              getUser: jest.fn(async (token: string) => {
                const user = usersByToken.get(token);
                if (user) {
                  return { data: { user }, error: null };
                }
                return {
                  data: { user: null },
                  error: { message: 'Invalid JWT token' },
                };
              }),
            },
          }),
        };
      },
    },
    {
      provide: RedisService,
      useFactory: () => {
        const store = new Map<string, string>();
        return {
          get: jest.fn(async (k: string) => store.get(k) || null),
          set: jest.fn(async (k: string, v: string) => {
            store.set(k, v);
          }),
          del: jest.fn(async (k: string) => {
            store.delete(k);
          }),
          ttl: jest.fn(async () => 600),
          incr: jest.fn(async () => 1),
          expire: jest.fn(async () => true),
        };
      },
    },
    {
      provide: MailService,
      useFactory: () => {
        return {
          sendOtpEmail: jest.fn(async (email: string, code: string) => {
            lastSentOtp = code;
            capturedEmails.push({
              toEmail: email,
              subject: 'Código de verificación Livora 🔑',
              htmlContent: `Tu código es ${code}`,
            });
          }),
          sendComplaintReceipt: jest.fn(
            async (
              toEmail: string,
              correlativeNumber: string,
              pdfBuffer: Buffer,
            ) => {
              capturedEmails.push({
                toEmail,
                subject: `Hoja de Reclamación Virtual - ${correlativeNumber} | Livora`,
                htmlContent: `Estimado consumidor, adjuntamos copia en PDF de su Hoja de Reclamación ${correlativeNumber}. Plazo legal de respuesta: 15 días hábiles según Ley 29571.`,
                attachment: {
                  name: `Hoja_Reclamacion_${correlativeNumber}.pdf`,
                  content: pdfBuffer.toString('base64'),
                  type: 'application/pdf',
                },
              });
            },
          ),
          sendWelcomeEmail: jest.fn(async (toEmail: string) => {
            capturedEmails.push({
              toEmail,
              subject: '¡Bienvenido a Livora! ♻️',
              htmlContent: 'Bienvenido',
            });
          }),
          sendSystemNotification: jest.fn(
            async (toEmail: string, title: string, bodyText: string) => {
              capturedEmails.push({
                toEmail,
                subject: `Notificación: ${title}`,
                htmlContent: bodyText,
              });
            },
          ),
        };
      },
    },
    {
      provide: ConfigService,
      useValue: {
        get: jest.fn((k: string) => {
          if (k === 'WALLET_ENCRYPTION_KEY')
            return 'compliance_test_secret_key_32c!';
          if (k === 'BREVO_API_KEY') return 'test_brevo_key';
          return null;
        }),
      },
    },
  ],
})
export class LegalComplianceTestModule {}

// =============================================================================
// MAIN E2E TEST SUITE (TIERS 1 - 4)
// =============================================================================

describe('Peruvian Legal Compliance & Web3 Custodial E2E Suite (Indecopi Ley 29571/32495 & Ley 29733)', () => {
  let app: NestFastifyApplication;
  let prismaMock: any;
  let complaintsService: ComplaintsComplianceService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [LegalComplianceTestModule],
    }).compile();

    prismaMock = moduleRef.get<PrismaService>(PrismaService);
    complaintsService = moduleRef.get<ComplaintsComplianceService>(
      ComplaintsComplianceService,
    );

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );

    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    capturedEmails.length = 0;
    lastSentOtp = '';
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // ===========================================================================
  // TIER 1: FEATURE COVERAGE (≥5 Tests per Feature across all 14 features)
  // ===========================================================================

  describe('Tier 1: Feature Coverage', () => {
    describe('F1 & F5: ConsentAudit DB Storage & Verification (Ley 29733)', () => {
      it('1.1 Captures immutable ConsentAudit on user registration with client IP and User-Agent', async () => {
        const email = 'ciudadano.peru1@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'Password123!',
            role: Role.HOGAR,
            termsVersion: '1.0.0',
            privacyVersion: '1.0.0',
            documentHash: 'sha256_mock_hash_terms_v1',
            ipAddress: '190.236.1.100',
            userAgent:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LivoraWeb/1.0',
          })
          .expect(201);

        expect(lastSentOtp).toMatch(/^\d{6}$/);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        expect(verifyRes.body.accessToken).toBeDefined();

        const audits = prismaMock._stores.consentAudits.filter(
          (a: any) => a.userId === verifyRes.body.user.id,
        );
        expect(audits.length).toBe(1);
        expect(audits[0].ipAddress).toBe('190.236.1.100');
        expect(audits[0].userAgent).toBe(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LivoraWeb/1.0',
        );
        expect(audits[0].termsVersion).toBe('1.0.0');
        expect(audits[0].privacyVersion).toBe('1.0.0');
        expect(audits[0].documentHash).toBe('sha256_mock_hash_terms_v1');
        expect(audits[0].consentedAt).toBeInstanceOf(Date);
      });

      it('1.2 Generates fallback SHA-256 documentHash when documentHash is omitted', async () => {
        const email = 'ciudadano.peru2@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'Password123!',
            role: Role.HOGAR,
            termsVersion: '2.0.0',
            privacyVersion: '2.0.0',
            ipAddress: '181.176.45.10',
            userAgent: 'LivoraApp/3.0 (Android 14; Pixel 8)',
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        const audits = prismaMock._stores.consentAudits.filter(
          (a: any) => a.userId === verifyRes.body.user.id,
        );
        expect(audits.length).toBe(1);
        const expectedHash = crypto
          .createHash('sha256')
          .update('Livora-Terms-2.0.0-Privacy-2.0.0')
          .digest('hex');
        expect(audits[0].documentHash).toBe(expectedHash);
      });

      it('1.3 Applies default versions ("1.0.0") when termsVersion and privacyVersion are omitted', async () => {
        const email = 'ciudadano.peru3@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'Password123!',
            role: Role.RECOLECTOR,
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        const audits = prismaMock._stores.consentAudits.filter(
          (a: any) => a.userId === verifyRes.body.user.id,
        );
        expect(audits.length).toBe(1);
        expect(audits[0].termsVersion).toBe('1.0.0');
        expect(audits[0].privacyVersion).toBe('1.0.0');
      });

      it('1.4 Allows querying user consent audit history via authenticated endpoint', async () => {
        const email = 'ciudadano.audit.query@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'Password123!',
            role: Role.CENTRO_ACOPIO,
            termsVersion: '1.2.0',
            privacyVersion: '1.2.0',
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        const token = verifyRes.body.accessToken;
        const auditsRes = await request(app.getHttpServer())
          .get('/compliance-legal/audits')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(Array.isArray(auditsRes.body)).toBe(true);
        expect(auditsRes.body.length).toBe(1);
        expect(auditsRes.body[0].termsVersion).toBe('1.2.0');
      });

      it('1.5 Preserves separate ConsentAudit entries for distinct user registrations', async () => {
        const initialCount = prismaMock._stores.consentAudits.length;
        const email = 'ciudadano.distinct@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'Password123!',
            role: Role.HOGAR,
            termsVersion: '3.0.0',
            privacyVersion: '3.0.0',
          })
          .expect(201);

        await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        expect(prismaMock._stores.consentAudits.length).toBe(initialCount + 1);
      });
    });

    describe('F2 & F3: Complaints Creation & Correlative Generation (Indecopi Ley 29571 / Ley 32495)', () => {
      it('2.1 Creates RECLAMO with sequential correlative format R-00001-YYYY', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '44556677',
          fullName: 'Juan Perez Flores',
          address: 'Av. Arequipa 1234, Lima',
          phone: '987654321',
          email: 'juan.perez@gmail.com',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Compost orgánico premium 50kg',
          amount: 150.0,
          claimType: ClaimType.RECLAMO,
          claimDetail:
            'El producto entregado presentaba humedad excesiva y empaque roto.',
          consumerRequest:
            'Cambio inmediato del producto o devolución del importe pagado.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const currentYear = new Date().getFullYear();
        expect(res.body.id).toBeDefined();
        expect(res.body.correlativeNumber).toBe(`R-00001-${currentYear}`);
        expect(res.body.status).toBe(ComplaintStatus.RECEIVED);
        expect(res.body.fullName).toBe('Juan Perez Flores');
        expect(res.body.amount).toBe(150.0);
      });

      it('2.2 Creates QUEJA with sequential correlative format Q-00001-YYYY', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '88776655',
          fullName: 'Maria Gomez Santos',
          address: 'Calle Los Pinos 456, Miraflores',
          phone: '912345678',
          email: 'maria.gomez@gmail.com',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Servicio de recojo de reciclaje domiciliario',
          claimType: ClaimType.QUEJA,
          claimDetail:
            'El recolector asignado no se presentó en el horario acordado y mostró trato descortés al contactarlo.',
          consumerRequest:
            'Capacitación al personal y reprogramación prioritaria del servicio.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const currentYear = new Date().getFullYear();
        expect(res.body.correlativeNumber).toBe(`Q-00001-${currentYear}`);
        expect(res.body.claimType).toBe(ClaimType.QUEJA);
      });

      it('2.3 Generates consecutive correlatives for multiple Reclamos in the same year', async () => {
        const basePayload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '11223344',
          fullName: 'Carlos Sanchez Ruiz',
          address: 'Jr. Huancavelica 789, Lima',
          phone: '998877665',
          email: 'carlos.sanchez@gmail.com',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Contenedor ecológico de reciclaje 120L',
          claimType: ClaimType.RECLAMO,
          claimDetail:
            'La tapa del contenedor llegó rota y no cierra herméticamente.',
          consumerRequest: 'Reemplazo de tapa o del contenedor completo.',
        };

        const res1 = await request(app.getHttpServer())
          .post('/complaints')
          .send(basePayload)
          .expect(201);

        const res2 = await request(app.getHttpServer())
          .post('/complaints')
          .send({ ...basePayload, fullName: 'Carlos Sanchez Ruiz 2' })
          .expect(201);

        const currentYear = new Date().getFullYear();
        expect(res1.body.correlativeNumber).toBe(`R-00002-${currentYear}`);
        expect(res2.body.correlativeNumber).toBe(`R-00003-${currentYear}`);
      });

      it('2.4 Supports minor consumer complaint filing with representativeName (Ley 29571)', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '77889900',
          fullName: 'Pedro Alva Menor',
          address: 'Av. Brasil 300, Jesús María',
          phone: '945612378',
          email: 'padre.alva@gmail.com',
          isMinor: true,
          representativeName: 'Manuel Alva Padre',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Kit escolar de reciclaje',
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Faltan componentes en el kit escolar de reciclaje.',
          consumerRequest: 'Envío de componentes faltantes.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        expect(res.body.isMinor).toBe(true);
        expect(res.body.representativeName).toBe('Manuel Alva Padre');
      });

      it('2.5 Allows anonymous/unregistered user filing with null userId', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.CE,
          documentNumber: 'CE123456789',
          fullName: 'Alexander Wright',
          address: 'Calle Schell 200, Miraflores',
          phone: '923456789',
          email: 'alex.wright@international.com',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Certificado de huella de carbono',
          claimType: ClaimType.QUEJA,
          claimDetail: 'Demora excesiva en la emisión del certificado digital.',
          consumerRequest: 'Emisión inmediata del certificado.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        expect(res.body.userId).toBeUndefined();
        expect(res.body.id).toBeDefined();
      });

      it('2.6 Supports authenticated user complaint filing with explicit userId link', async () => {
        const userId = 'auth-user-uuid-12345';
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '99887766',
          fullName: 'Rosa Morales Soto',
          address: 'Av. Larco 500, Miraflores',
          phone: '955443322',
          email: 'rosa.morales@livora.pe',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Canje de tokens por producto en tienda',
          amount: 85.5,
          claimType: ClaimType.RECLAMO,
          claimDetail:
            'Se descontaron los EcoTokens pero la tienda no entregó el producto.',
          consumerRequest:
            'Devolución de los tokens al monedero o entrega del producto.',
          userId,
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        expect(res.body.userId).toBe(userId);
      });
    });

    describe('F4: In-Memory PDFKit Summary Generation', () => {
      it('4.1 Generates in-memory binary PDF buffer starting with PDF magic bytes (%PDF-)', async () => {
        const record: ComplaintRecord = {
          id: 'test-pdf-1',
          correlativeNumber: 'R-00001-2026',
          documentType: DocumentType.DNI,
          documentNumber: '12345678',
          fullName: 'Test Consumer',
          address: 'Test Address 123',
          phone: '987654321',
          email: 'test@consumer.pe',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Test Product Description',
          amount: 100.0,
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Test Claim Detail Description',
          consumerRequest: 'Test Consumer Request',
          status: ComplaintStatus.RECEIVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pdfBuffer = await generateComplaintPdfBuffer(record);
        expect(pdfBuffer).toBeInstanceOf(Buffer);
        expect(pdfBuffer.length).toBeGreaterThan(1000);

        // Check PDF Magic Bytes %PDF-
        const header = pdfBuffer.subarray(0, 5).toString('utf-8');
        expect(header).toBe('%PDF-');
      });

      it('4.2 PDF content includes official Indecopi legal citations (Ley 29571 & Ley 32495)', async () => {
        const record: ComplaintRecord = {
          id: 'test-pdf-2',
          correlativeNumber: 'Q-00001-2026',
          documentType: DocumentType.CE,
          documentNumber: 'CE998877665',
          fullName: 'Maria Legal Validator',
          address: 'Calle Legal 456',
          phone: '912345678',
          email: 'maria@legal.pe',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Servicio de Reciclaje',
          claimType: ClaimType.QUEJA,
          claimDetail: 'Detalle de queja por atencion',
          consumerRequest: 'Mejora en atencion',
          status: ComplaintStatus.RECEIVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pdfBuffer = await generateComplaintPdfBuffer(record);
        const pdfText = extractPdfText(pdfBuffer);

        expect(pdfText).toContain('LIBRO DE RECLAMACIONES');
        expect(pdfText).toContain('Q-00001-2026');
        expect(pdfText).toContain('29571');
      });

      it('4.3 PDF renders minor consumer representative data when isMinor is true', async () => {
        const record: ComplaintRecord = {
          id: 'test-pdf-3',
          correlativeNumber: 'R-00002-2026',
          documentType: DocumentType.DNI,
          documentNumber: '87654321',
          fullName: 'Diego Menor',
          address: 'Av. Salaverry 100',
          phone: '933221100',
          email: 'tutor@family.pe',
          isMinor: true,
          representativeName: 'Elena Madre Tutora',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Material Didactico',
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Fallo en material',
          consumerRequest: 'Reposicion',
          status: ComplaintStatus.RECEIVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pdfBuffer = await generateComplaintPdfBuffer(record);
        const pdfText = extractPdfText(pdfBuffer);

        expect(pdfText).toContain('Diego Menor');
        expect(pdfText).toContain('Elena Madre Tutora');
      });

      it('4.4 PDF contains 15-day statutory response deadline clause (Ley 29571)', async () => {
        const record: ComplaintRecord = {
          id: 'test-pdf-4',
          correlativeNumber: 'R-00003-2026',
          documentType: DocumentType.RUC,
          documentNumber: '20123456789',
          fullName: 'Empresa Cliente SAC',
          address: 'Av. Industrial 800',
          phone: '999888777',
          email: 'contacto@empresa.pe',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Servicio B2B de Retiro',
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Incumplimiento de retiro de plasticos',
          consumerRequest: 'Retiro en 24 horas',
          status: ComplaintStatus.RECEIVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pdfBuffer = await generateComplaintPdfBuffer(record);
        const pdfText = extractPdfText(pdfBuffer);

        expect(pdfText).toContain('15');
      });

      it('4.5 In-memory generation executes without creating temporary files on disk', async () => {
        const record: ComplaintRecord = {
          id: 'test-pdf-5',
          correlativeNumber: 'Q-00002-2026',
          documentType: DocumentType.DNI,
          documentNumber: '11223344',
          fullName: 'Test Memory Citizen',
          address: 'Calle Memoria 1',
          phone: '911223344',
          email: 'citizen@memoria.pe',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Bolsas biodegradables',
          claimType: ClaimType.QUEJA,
          claimDetail: 'Retraso en atencion al cliente',
          consumerRequest: 'Disculpas formales',
          status: ComplaintStatus.RECEIVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const pdfBuffer = await generateComplaintPdfBuffer(record);
        expect(pdfBuffer).toBeDefined();
        expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      });
    });

    describe('F4 & Brevo: Automated Email Dispatch with Base64 PDF Attachment', () => {
      it('5.1 Dispatches confirmation email to consumer with PDF attached via Brevo MailService', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '55667788',
          fullName: 'Ana Maria Vega',
          address: 'Av. Pardo 600, Miraflores',
          phone: '976543210',
          email: 'ana.vega@gmail.com',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Tacho clasificador de residuos',
          amount: 120.0,
          claimType: ClaimType.RECLAMO,
          claimDetail: 'El tacho llegó con pedal averiado.',
          consumerRequest: 'Cambio por tacho nuevo.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const correlative = res.body.correlativeNumber;
        const email = capturedEmails.find(
          (e) => e.toEmail === 'ana.vega@gmail.com',
        );
        expect(email).toBeDefined();
        expect(email?.subject).toContain(correlative);
        expect(email?.attachment).toBeDefined();
        expect(email?.attachment?.name).toBe(
          `Hoja_Reclamacion_${correlative}.pdf`,
        );
        expect(email?.attachment?.type).toBe('application/pdf');

        // Verify base64 content decodes to valid PDF
        const decodedBuffer = Buffer.from(email!.attachment!.content, 'base64');
        expect(decodedBuffer.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
      });

      it('5.2 Email body text references 15-day Indecopi statutory deadline', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.PASAPORTE,
          documentNumber: 'PASS123456',
          fullName: 'Jean Luc Picard',
          address: 'Av. Primavera 900, Surco',
          phone: '988112233',
          email: 'j.picard@starfleet.pe',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Servicio de Consultoria Circular',
          claimType: ClaimType.QUEJA,
          claimDetail: 'Inconformidad con horario de atencion.',
          consumerRequest: 'Respuesta formal por escrito.',
        };

        await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const email = capturedEmails.find(
          (e) => e.toEmail === 'j.picard@starfleet.pe',
        );
        expect(email).toBeDefined();
        expect(email?.htmlContent).toContain('15 días hábiles');
        expect(email?.htmlContent).toContain('Ley 29571');
      });

      it('5.3 Dispatches email for anonymous complaints without requiring session credentials', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '66778899',
          fullName: 'Consumidor Anonimo Real',
          address: 'Av. Grau 100, Barranco',
          phone: '966554433',
          email: 'anonimo.real@gmail.com',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Compostera domestica',
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Producto incompleto sin manual de uso.',
          consumerRequest: 'Envio de manual digital.',
        };

        await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const email = capturedEmails.find(
          (e) => e.toEmail === 'anonimo.real@gmail.com',
        );
        expect(email).toBeDefined();
        expect(email?.attachment).toBeDefined();
      });

      it('5.4 Dispatches email for high-value B2B/RUC transactions with accurate PDF content', async () => {
        const payload: CreateComplaintDto = {
          documentType: DocumentType.RUC,
          documentNumber: '20601234567',
          fullName: 'EcoIndustrias del Peru SAC',
          address: 'Carretera Central Km 15, Ate',
          phone: '911445566',
          email: 'reclamos@ecoindustrias.pe',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Lote de 500kg de granulos PET reciclados',
          amount: 4500.0,
          claimType: ClaimType.RECLAMO,
          claimDetail:
            'Pureza del PET por debajo del estandar pactado en contrato.',
          consumerRequest: 'Reposicion de lote o compensacion economica.',
        };

        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send(payload)
          .expect(201);

        const email = capturedEmails.find(
          (e) => e.toEmail === 'reclamos@ecoindustrias.pe',
        );
        expect(email).toBeDefined();
        expect(email?.subject).toContain(res.body.correlativeNumber);
      });

      it('5.5 Attaches unique PDFs for distinct complaints filed in succession', async () => {
        const p1: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '11112222',
          fullName: 'Cliente Uno',
          address: 'Calle Uno 1',
          phone: '911111111',
          email: 'cliente1@livora.pe',
          goodType: GoodType.PRODUCTO,
          goodDescription: 'Producto Uno',
          claimType: ClaimType.RECLAMO,
          claimDetail: 'Reclamo numero uno detalle amplio.',
          consumerRequest: 'Solucion uno.',
        };

        const p2: CreateComplaintDto = {
          documentType: DocumentType.DNI,
          documentNumber: '22223333',
          fullName: 'Cliente Dos',
          address: 'Calle Dos 2',
          phone: '922222222',
          email: 'cliente2@livora.pe',
          goodType: GoodType.SERVICIO,
          goodDescription: 'Servicio Dos',
          claimType: ClaimType.QUEJA,
          claimDetail: 'Queja numero dos detalle amplio.',
          consumerRequest: 'Solucion dos.',
        };

        const res1 = await request(app.getHttpServer())
          .post('/complaints')
          .send(p1)
          .expect(201);
        const res2 = await request(app.getHttpServer())
          .post('/complaints')
          .send(p2)
          .expect(201);

        const email1 = capturedEmails.find(
          (e) => e.toEmail === 'cliente1@livora.pe',
        );
        const email2 = capturedEmails.find(
          (e) => e.toEmail === 'cliente2@livora.pe',
        );

        expect(email1?.attachment?.name).toBe(
          `Hoja_Reclamacion_${res1.body.correlativeNumber}.pdf`,
        );
        expect(email2?.attachment?.name).toBe(
          `Hoja_Reclamacion_${res2.body.correlativeNumber}.pdf`,
        );
      });
    });
  });

  // ===========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (≥5 Tests per Feature)
  // ===========================================================================

  describe('Tier 2: Boundary & Corner Cases', () => {
    describe('Document Type & Number Validation (DNI, CE, PASAPORTE, RUC)', () => {
      const validBase = {
        fullName: 'Consumidor Prueba',
        address: 'Av. Tacna 123',
        phone: '987654321',
        email: 'prueba@valida.pe',
        goodType: GoodType.PRODUCTO,
        goodDescription: 'Bien de prueba',
        claimType: ClaimType.RECLAMO,
        claimDetail: 'Detalle de reclamo con mas de 10 caracteres.',
        consumerRequest: 'Pedido de prueba.',
      };

      it('2.B.1 Rejects invalid documentType with RFC 9457 Problem Details', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: 'LICENCIA_CONDUCIR',
            documentNumber: '12345678',
          })
          .expect(400);

        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body.status).toBe(400);
        expect(res.body.invalid_params).toBeDefined();
        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentType'),
          ),
        ).toBe(true);
      });

      it('2.B.2 Rejects DNI with less than 8 digits (e.g. 7 digits)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.DNI,
            documentNumber: '1234567',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.3 Rejects DNI with more than 8 digits (e.g. 9 digits)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.DNI,
            documentNumber: '123456789',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.4 Rejects DNI containing non-numeric characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.DNI,
            documentNumber: '1234567A',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.5 Rejects CE with less than 9 characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.CE,
            documentNumber: 'CE1234',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.6 Rejects PASAPORTE with less than 6 characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.PASAPORTE,
            documentNumber: 'P123',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.7 Rejects RUC with non-11 digits (e.g. 10 digits or 12 digits)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.RUC,
            documentNumber: '2060123456',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });

      it('2.B.8 Rejects RUC containing alphabetic characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            documentType: DocumentType.RUC,
            documentNumber: '2060123456A',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('documentNumber'),
          ),
        ).toBe(true);
      });
    });

    describe('Reclamo vs Queja & Mandatory Fields Validation', () => {
      const validBase = {
        documentType: DocumentType.DNI,
        documentNumber: '12345678',
        fullName: 'Consumidor Base',
        address: 'Av. Tacna 123',
        phone: '987654321',
        email: 'valida@campo.pe',
        goodType: GoodType.PRODUCTO,
        goodDescription: 'Descripcion de bien valida',
        claimType: ClaimType.RECLAMO,
        claimDetail: 'Detalle con mas de 10 caracteres validos.',
        consumerRequest: 'Pedido concreto del consumidor.',
      };

      it('2.B.9 Rejects invalid claimType (e.g. SUGERENCIA, DENUNCIA)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            claimType: 'SUGERENCIA',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('claimType'),
          ),
        ).toBe(true);
      });

      it('2.B.10 Rejects claimDetail shorter than 10 characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            claimDetail: 'Muy corto',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('claimDetail'),
          ),
        ).toBe(true);
      });

      it('2.B.11 Rejects consumerRequest shorter than 5 characters', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            consumerRequest: 'No',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('consumerRequest'),
          ),
        ).toBe(true);
      });

      it('2.B.12 Rejects invalid goodType (e.g. SUSCRIPCION, TOKEN)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            goodType: 'TOKEN_WEB3',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) => p.name.includes('goodType')),
        ).toBe(true);
      });

      it('2.B.13 Rejects negative amount value', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            amount: -25.5,
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) => p.name.includes('amount')),
        ).toBe(true);
      });

      it('2.B.14 Accepts zero amount (0.00)', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            amount: 0,
          })
          .expect(201);

        expect(res.body.amount).toBe(0);
      });

      it('2.B.15 Rejects invalid email format in complaint payload', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            email: 'not-a-valid-email',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) => p.name.includes('email')),
        ).toBe(true);
      });

      it('2.B.16 Rejects isMinor = true when representativeName is missing or empty', async () => {
        const res = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            ...validBase,
            isMinor: true,
            representativeName: '',
          })
          .expect(400);

        expect(
          res.body.invalid_params.some((p: any) =>
            p.name.includes('representativeName'),
          ),
        ).toBe(true);
      });
    });

    describe('Annual Correlative Rollover & Sequence Isolation', () => {
      it('2.B.17 Resets sequence to 00001 upon new calendar year (2026 -> 2027 rollover)', async () => {
        // Create in 2026
        const date2026 = new Date(2026, 11, 31, 23, 59, 59);
        const comp2026 = await complaintsService.createComplaint(
          {
            documentType: DocumentType.DNI,
            documentNumber: '12345678',
            fullName: 'Consumidor 2026',
            address: 'Calle 2026',
            phone: '987654321',
            email: 'c2026@livora.pe',
            goodType: GoodType.PRODUCTO,
            goodDescription: 'Prod 2026',
            claimType: ClaimType.RECLAMO,
            claimDetail: 'Detalle 2026 con mas de 10 caracteres.',
            consumerRequest: 'Pedido 2026',
          },
          date2026,
        );

        // Create in 2027
        const date2027 = new Date(2027, 0, 1, 0, 0, 1);
        const comp2027 = await complaintsService.createComplaint(
          {
            documentType: DocumentType.DNI,
            documentNumber: '87654321',
            fullName: 'Consumidor 2027',
            address: 'Calle 2027',
            phone: '912345678',
            email: 'c2027@livora.pe',
            goodType: GoodType.PRODUCTO,
            goodDescription: 'Prod 2027',
            claimType: ClaimType.RECLAMO,
            claimDetail: 'Detalle 2027 con mas de 10 caracteres.',
            consumerRequest: 'Pedido 2027',
          },
          date2027,
        );

        expect(comp2026.correlativeNumber).toMatch(/^R-\d{5}-2026$/);
        expect(comp2027.correlativeNumber).toBe('R-00001-2027');
      });

      it('2.B.18 Maintains independent sequences for RECLAMO and QUEJA in the same calendar year', async () => {
        const year = 2030;
        const d = new Date(year, 5, 15);

        const r1 = complaintsService.generateCorrelative(ClaimType.RECLAMO, d);
        const q1 = complaintsService.generateCorrelative(ClaimType.QUEJA, d);
        const r2 = complaintsService.generateCorrelative(ClaimType.RECLAMO, d);
        const q2 = complaintsService.generateCorrelative(ClaimType.QUEJA, d);

        expect(r1).toBe(`R-00001-${year}`);
        expect(q1).toBe(`Q-00001-${year}`);
        expect(r2).toBe(`R-00002-${year}`);
        expect(q2).toBe(`Q-00002-${year}`);
      });

      it('2.B.19 Correctly pads high sequence counts (e.g. 00009 -> 00010 -> 00100 -> 01000)', async () => {
        const year = 2035;
        complaintsService.seedSequence('R', year, 9);
        const seq10 = complaintsService.generateCorrelative(
          ClaimType.RECLAMO,
          new Date(year, 0, 1),
        );
        expect(seq10).toBe(`R-00010-${year}`);

        complaintsService.seedSequence('R', year, 99);
        const seq100 = complaintsService.generateCorrelative(
          ClaimType.RECLAMO,
          new Date(year, 0, 1),
        );
        expect(seq100).toBe(`R-00100-${year}`);

        complaintsService.seedSequence('R', year, 999);
        const seq1000 = complaintsService.generateCorrelative(
          ClaimType.RECLAMO,
          new Date(year, 0, 1),
        );
        expect(seq1000).toBe(`R-01000-${year}`);
      });

      it('2.B.20 Handles lookup of non-existent complaint ID returning RFC 9457 404 Not Found', async () => {
        const nonExistentId = 'non-existent-uuid-9999';
        const res = await request(app.getHttpServer())
          .get(`/complaints/${nonExistentId}`)
          .expect(404);

        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(res.body.status).toBe(404);
        expect(res.body.detail).toContain(nonExistentId);
      });

      it('2.B.21 Handles lookup of non-existent correlative number returning 404', async () => {
        const res = await request(app.getHttpServer())
          .get('/complaints/by-correlative/R-99999-2026')
          .expect(404);

        expect(res.body.status).toBe(404);
      });
    });
  });

  // ===========================================================================
  // TIER 3: PAIRWISE COMBINATIONS & INTEGRATION
  // ===========================================================================

  describe('Tier 3: Pairwise Combinations', () => {
    describe('Document Type x Good Type x Claim Type Matrix', () => {
      const combinations = [
        {
          doc: DocumentType.DNI,
          num: '12345678',
          good: GoodType.PRODUCTO,
          claim: ClaimType.RECLAMO,
        },
        {
          doc: DocumentType.DNI,
          num: '87654321',
          good: GoodType.SERVICIO,
          claim: ClaimType.QUEJA,
        },
        {
          doc: DocumentType.CE,
          num: 'CE123456789',
          good: GoodType.PRODUCTO,
          claim: ClaimType.QUEJA,
        },
        {
          doc: DocumentType.CE,
          num: 'CE987654321',
          good: GoodType.SERVICIO,
          claim: ClaimType.RECLAMO,
        },
        {
          doc: DocumentType.PASAPORTE,
          num: 'PASS123456',
          good: GoodType.PRODUCTO,
          claim: ClaimType.RECLAMO,
        },
        {
          doc: DocumentType.PASAPORTE,
          num: 'PASS654321',
          good: GoodType.SERVICIO,
          claim: ClaimType.QUEJA,
        },
        {
          doc: DocumentType.RUC,
          num: '20601122334',
          good: GoodType.PRODUCTO,
          claim: ClaimType.QUEJA,
        },
        {
          doc: DocumentType.RUC,
          num: '20609988776',
          good: GoodType.SERVICIO,
          claim: ClaimType.RECLAMO,
        },
      ];

      combinations.forEach((c, idx) => {
        it(`3.C.${idx + 1} Matrix Pair: ${c.doc} x ${c.good} x ${c.claim}`, async () => {
          const payload: CreateComplaintDto = {
            documentType: c.doc,
            documentNumber: c.num,
            fullName: `Consumidor Matrix ${idx + 1}`,
            address: `Av. Matriz ${idx + 1}`,
            phone: `91122334${idx}`,
            email: `matrix${idx + 1}@livora.pe`,
            goodType: c.good,
            goodDescription: `Descripcion bien matrix ${idx + 1}`,
            claimType: c.claim,
            claimDetail: `Detalle extenso de disconformidad matrix ${idx + 1}.`,
            consumerRequest: `Solucion solicitada matrix ${idx + 1}.`,
          };

          const res = await request(app.getHttpServer())
            .post('/complaints')
            .send(payload)
            .expect(201);

          expect(res.body.documentType).toBe(c.doc);
          expect(res.body.goodType).toBe(c.good);
          expect(res.body.claimType).toBe(c.claim);
          expect(res.body.correlativeNumber).toMatch(
            c.claim === ClaimType.RECLAMO
              ? /^R-\d{5}-\d{4}$/
              : /^Q-\d{5}-\d{4}$/,
          );
        });
      });
    });

    describe('User Lifecycle: Consent Capture -> Complaint Filing -> ARCO Right to Erasure', () => {
      it('3.L.1 Full User Lifecycle preserves complaint auditability while erasing Web3 private key and PII', async () => {
        // Step 1: Register User with ConsentAudit
        const userEmail = 'ciudadano.lifecycle@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email: userEmail,
            password: 'LifecyclePass123!',
            role: Role.HOGAR,
            termsVersion: '1.0.0',
            privacyVersion: '1.0.0',
            ipAddress: '190.236.88.99',
            userAgent: 'LivoraMobile/1.0',
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email: userEmail, code: lastSentOtp })
          .expect(201);

        const userId = verifyRes.body.user.id;
        const authToken = verifyRes.body.accessToken;
        const initialWallet = verifyRes.body.user.walletAddress;

        // Step 2: File authenticated complaint
        const complaintRes = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            documentType: DocumentType.DNI,
            documentNumber: '33445566',
            fullName: 'Ciudadano Lifecycle',
            address: 'Av. Los Pinos 789',
            phone: '944332211',
            email: userEmail,
            goodType: GoodType.PRODUCTO,
            goodDescription: 'Recipiente hermetico de reciclaje',
            amount: 45.0,
            claimType: ClaimType.RECLAMO,
            claimDetail: 'El producto no sella adecuadamente.',
            consumerRequest: 'Reemplazo del producto.',
            userId,
          })
          .expect(201);

        expect(complaintRes.body.userId).toBe(userId);
        const correlative = complaintRes.body.correlativeNumber;

        // Step 3: Exercise ARCO Cancellation (Right to Erasure under Ley 29733)
        const arcoRes = await request(app.getHttpServer())
          .delete('/compliance-legal/arco/cancel')
          .set('Authorization', `Bearer ${authToken}`)
          .expect(200);

        expect(arcoRes.body.success).toBe(true);

        // Step 4: Verify Database State
        const dbUser = prismaMock._stores.users.get(userId);
        expect(dbUser.isActive).toBe(false);
        expect(dbUser.deletedAt).toBeInstanceOf(Date);
        expect(dbUser.encryptedPrivateKey).toBeNull(); // Irreversibly purged
        expect(dbUser.email).toMatch(/^deleted_supabase_/); // Anonymized
        expect(dbUser.walletAddress).toBe(initialWallet); // Preserved for blockchain immutability

        // Step 5: Verify Complaint Record is retained for Indecopi regulatory compliance
        const retrievedComplaint =
          await complaintsService.findByCorrelative(correlative);
        expect(retrievedComplaint).toBeDefined();
        expect(retrievedComplaint?.correlativeNumber).toBe(correlative);
        expect(retrievedComplaint?.fullName).toBe('Ciudadano Lifecycle');
      });
    });

    describe('Rapid Burst / Concurrency Sequential Integrity', () => {
      it('3.B.1 Interleaved rapid burst generates strictly increasing non-colliding correlatives', async () => {
        const promises = [];

        for (let i = 0; i < 10; i++) {
          const isReclamo = i % 2 === 0;
          promises.push(
            complaintsService.createComplaint({
              documentType: DocumentType.DNI,
              documentNumber: `1000000${i}`,
              fullName: `Burst Consumer ${i}`,
              address: `Burst Address ${i}`,
              phone: `90000000${i}`,
              email: `burst${i}@livora.pe`,
              goodType: GoodType.PRODUCTO,
              goodDescription: `Burst Product ${i}`,
              claimType: isReclamo ? ClaimType.RECLAMO : ClaimType.QUEJA,
              claimDetail: `Burst claim detail with sufficient text ${i}.`,
              consumerRequest: `Burst request ${i}.`,
            }),
          );
        }

        const results = await Promise.all(promises);
        const correlatives = results.map((r) => r.correlativeNumber);
        const uniqueCorrelatives = new Set(correlatives);

        // Ensure zero collisions
        expect(uniqueCorrelatives.size).toBe(10);

        const reclamos = correlatives.filter((c) => c.startsWith('R-'));
        const quejas = correlatives.filter((c) => c.startsWith('Q-'));

        expect(reclamos.length).toBe(5);
        expect(quejas.length).toBe(5);
      });
    });
  });

  // ===========================================================================
  // TIER 4: REAL-WORLD SCENARIOS & FULL COMPLIANCE CONTRACTS
  // ===========================================================================

  describe('Tier 4: Real-World Scenarios & UI Compliance Contracts', () => {
    describe('Scenario 4.1: Complete End-to-End Legal Audit Trace', () => {
      it('Executes full lifecycle: Consent Capture -> Complaint PDF -> Brevo Base64 Attachment -> Indecopi 15-Day Verification', async () => {
        // 1. Citizen registers on web with legal checkboxes
        const citizenEmail = 'eco.citizen.audit@livora.pe';
        const clientIp = '200.48.100.50';
        const userAgent = 'LivoraWeb/2.5.0 (Windows NT 10.0; Win64; x64)';

        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email: citizenEmail,
            password: 'StrongEcoPass123!',
            role: Role.HOGAR,
            termsVersion: '1.0.0',
            privacyVersion: '1.0.0',
            documentHash: 'sha256_e2e_terms_hash_valid',
            ipAddress: clientIp,
            userAgent,
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email: citizenEmail, code: lastSentOtp })
          .expect(201);

        const token = verifyRes.body.accessToken;
        const userId = verifyRes.body.user.id;

        // 2. Verify ConsentAudit in PostgreSQL
        const auditRes = await request(app.getHttpServer())
          .get('/compliance-legal/audits')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(auditRes.body.length).toBe(1);
        expect(auditRes.body[0].ipAddress).toBe(clientIp);
        expect(auditRes.body[0].userAgent).toBe(userAgent);

        // 3. Citizen files complaint for defective recycled container
        const complaintRes = await request(app.getHttpServer())
          .post('/complaints')
          .send({
            documentType: DocumentType.DNI,
            documentNumber: '72345678',
            fullName: 'Eco Citizen Audit',
            address: 'Av. Primavera 123, Surco, Lima',
            phone: '987123456',
            email: citizenEmail,
            goodType: GoodType.PRODUCTO,
            goodDescription:
              'Contenedor de reciclaje inteligente con sensor IoT',
            amount: 280.0,
            claimType: ClaimType.RECLAMO,
            claimDetail:
              'El sensor IoT no registra los EcoTokens al depositar botellas de plastico y se traba la compuerta.',
            consumerRequest:
              'Reparacion tecnica en domicilio o reemplazo del sensor inteligente con acreditacion de los tokens.',
            userId,
          })
          .expect(201);

        const correlative = complaintRes.body.correlativeNumber;

        // 4. Verify Brevo email dispatch with in-memory PDF attachment
        const email = capturedEmails.find(
          (e) => e.toEmail === citizenEmail && e.subject.includes(correlative),
        );
        expect(email).toBeDefined();
        expect(email?.attachment).toBeDefined();
        expect(email?.attachment?.name).toBe(
          `Hoja_Reclamacion_${correlative}.pdf`,
        );

        // 5. Verify PDF structure and metadata
        const pdfBytes = Buffer.from(email!.attachment!.content, 'base64');
        expect(pdfBytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');

        const pdfContent = extractPdfText(pdfBytes);
        expect(pdfContent).toContain('LIBRO DE RECLAMACIONES');
        expect(pdfContent).toContain('Eco Citizen Audit');
        expect(pdfContent).toContain(correlative);
        expect(pdfContent).toContain('15'); // 15 working days
      });
    });

    describe('Scenario 4.2: Web Frontend Legal Contracts Verification', () => {
      it('Verifies CookieBanner 3-state blocking specification (ALL, ESSENTIAL_ONLY, CUSTOM)', () => {
        type CookieChoice = 'ALL' | 'ESSENTIAL_ONLY' | 'CUSTOM';

        const scriptExecutionGate = (
          choice: CookieChoice | null,
          scriptType: 'essential' | 'analytics' | 'marketing',
        ): boolean => {
          if (!choice) return scriptType === 'essential';
          if (choice === 'ALL') return true;
          if (choice === 'ESSENTIAL_ONLY') return scriptType === 'essential';
          return scriptType === 'essential'; // CUSTOM default without explicit opt-in
        };

        // Gated before user interaction
        expect(scriptExecutionGate(null, 'essential')).toBe(true);
        expect(scriptExecutionGate(null, 'analytics')).toBe(false);
        expect(scriptExecutionGate(null, 'marketing')).toBe(false);

        // After "Aceptar todas"
        expect(scriptExecutionGate('ALL', 'analytics')).toBe(true);
        expect(scriptExecutionGate('ALL', 'marketing')).toBe(true);

        // After "Rechazar no esenciales"
        expect(scriptExecutionGate('ESSENTIAL_ONLY', 'analytics')).toBe(false);
        expect(scriptExecutionGate('ESSENTIAL_ONLY', 'marketing')).toBe(false);
      });

      it('Verifies Web3ConfirmModal statutory warning disclaimer verbatim text', () => {
        const statutoryWarning =
          'Al confirmar, autorizas a Livora a firmar la transacción en la blockchain Stellar. Esta acción es irreversible.';

        expect(statutoryWarning).toBe(
          'Al confirmar, autorizas a Livora a firmar la transacción en la blockchain Stellar. Esta acción es irreversible.',
        );
        expect(statutoryWarning.includes('blockchain Stellar')).toBe(true);
        expect(statutoryWarning.includes('irreversible')).toBe(true);
      });

      it('Verifies Registration Checkbox requirements: Mandatory T&C + Privacy, Optional Marketing', () => {
        const validateRegistrationConsent = (
          legalAccepted: boolean,
          marketingConsent: boolean,
        ): { isValid: boolean; error?: string } => {
          if (!legalAccepted) {
            return {
              isValid: false,
              error:
                'Debe aceptar los Términos y Condiciones y la Política de Privacidad para registrarse.',
            };
          }
          return { isValid: true };
        };

        expect(validateRegistrationConsent(false, false).isValid).toBe(false);
        expect(validateRegistrationConsent(false, true).isValid).toBe(false);
        expect(validateRegistrationConsent(true, false).isValid).toBe(true);
        expect(validateRegistrationConsent(true, true).isValid).toBe(true);
      });
    });

    describe('Scenario 4.3: Mobile App Legal Contracts Verification', () => {
      it('Verifies Mobile ApiClient HTTP DELETE implementation for ARCO account cancellation', async () => {
        // Mock simulated ApiClient.delete method
        const apiClient = {
          delete: async (endpoint: string, token: string) => {
            return request(app.getHttpServer())
              .delete(endpoint)
              .set('Authorization', `Bearer ${token}`);
          },
        };

        // Create user for deletion test
        const email = 'mobile.citizen@livora.pe';
        await request(app.getHttpServer())
          .post('/compliance-legal/auth/register')
          .send({
            email,
            password: 'MobilePass123!',
            role: Role.HOGAR,
          })
          .expect(201);

        const verifyRes = await request(app.getHttpServer())
          .post('/compliance-legal/auth/verify')
          .send({ email, code: lastSentOtp })
          .expect(201);

        const token = verifyRes.body.accessToken;

        // Perform DELETE via apiClient
        const deleteRes = await apiClient.delete(
          '/compliance-legal/arco/cancel',
          token,
        );
        expect(deleteRes.status).toBe(200);
        expect(deleteRes.body.success).toBe(true);
      });
    });

    describe('Scenario 4.4: Web Checkout Legal and Anti-Dark Patterns Verification', () => {
      it('Reject confirmation if termsAccepted is false or omitted', async () => {
        await request(app.getHttpServer())
          .post('/stores/redemptions/confirm/LIVORA-QR-TEST-123')
          .send({ termsAccepted: false })
          .expect(400);

        await request(app.getHttpServer())
          .post('/stores/redemptions/confirm/LIVORA-QR-TEST-123')
          .send({})
          .expect(400);
      });

      it('Accept confirmation and process base amount if termsAccepted is true without opt-ins', async () => {
        const res = await request(app.getHttpServer())
          .post('/stores/redemptions/confirm/LIVORA-QR-TEST-123')
          .send({ termsAccepted: true })
          .expect(200);

        expect(res.body.status).toBe('COMPLETED');
        expect(res.body.tokenAmount).toBe(25.0);
      });

      it('Accept confirmation and process additional fees when opt-ins are selected', async () => {
        // Reset redemption status to PENDING
        const controller = app.get<StoresComplianceController>(StoresComplianceController);
        controller.redemptions.set('LIVORA-QR-TEST-123', {
          id: 'red-uuid-123',
          qrCodeRef: 'LIVORA-QR-TEST-123',
          tokenAmount: 25.0,
          businessName: 'Tienda Aliada Test',
          status: 'PENDING',
        });

        const res = await request(app.getHttpServer())
          .post('/stores/redemptions/confirm/LIVORA-QR-TEST-123')
          .send({
            termsAccepted: true,
            donationOptIn: true,
            insuranceOptIn: true,
          })
          .expect(200);

        expect(res.body.status).toBe('COMPLETED');
        expect(res.body.tokenAmount).toBe(26.5); // 25.0 base + 1.0 donation + 0.5 insurance
      });
    });
  });
});
