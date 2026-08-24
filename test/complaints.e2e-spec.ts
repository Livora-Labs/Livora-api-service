import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { ComplaintsController } from '../src/complaints/complaints.controller';
import { ComplaintsService } from '../src/complaints/complaints.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/services/mail.service';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

interface MockComplaintRecord {
  id: string;
  correlativeNumber: string;
  documentType?: string;
  documentNumber?: string;
  fullName?: string;
  address?: string;
  phone?: string;
  email?: string;
  isMinor?: boolean;
  representativeName?: string | null;
  goodType?: string;
  goodDescription?: string;
  amount?: number | null;
  claimType?: string;
  claimDetail?: string;
  consumerRequest?: string;
  status?: string;
  userId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface DispatchedMailInfo {
  toEmail: string;
  fullName: string;
  correlativeNumber: string;
  claimType: string;
  pdfBuffer: Buffer;
}

interface ProblemDetailsResponse {
  status: number;
  detail: string;
  title?: string;
}

describe('Libro de Reclamaciones Virtual - Complaints API (E2E Suite)', () => {
  let app: NestFastifyApplication;
  let complaintsStore: Map<string, MockComplaintRecord>;
  let lastDispatchedMail: DispatchedMailInfo | null = null;

  beforeAll(async () => {
    complaintsStore = new Map<string, MockComplaintRecord>();

    const mockPrisma = {
      complaint: {
        findMany: jest.fn(
          ({
            where,
          }: {
            where?: {
              correlativeNumber?: { startsWith?: string; endsWith?: string };
            };
          }) => {
            const list = Array.from(complaintsStore.values());
            const filtered = list.filter((c) => {
              if (
                where?.correlativeNumber?.startsWith &&
                !c.correlativeNumber.startsWith(
                  where.correlativeNumber.startsWith,
                )
              ) {
                return false;
              }
              if (
                where?.correlativeNumber?.endsWith &&
                !c.correlativeNumber.endsWith(where.correlativeNumber.endsWith)
              ) {
                return false;
              }
              return true;
            });
            return Promise.resolve(filtered);
          },
        ),
        create: jest.fn(({ data }: { data: Partial<MockComplaintRecord> }) => {
          const id = `complaint-uuid-${complaintsStore.size + 1}`;
          const record: MockComplaintRecord = {
            id,
            correlativeNumber: data.correlativeNumber || '',
            ...data,
            status: 'OPEN',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          complaintsStore.set(id, record);
          return Promise.resolve(record);
        }),
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: { id?: string; correlativeNumber?: string };
          }) => {
            if (where.id) {
              return Promise.resolve(complaintsStore.get(where.id) || null);
            }
            if (where.correlativeNumber) {
              for (const item of complaintsStore.values()) {
                if (item.correlativeNumber === where.correlativeNumber) {
                  return Promise.resolve(item);
                }
              }
            }
            return Promise.resolve(null);
          },
        ),
      },
    };

    const mockMailService = {
      sendComplaintConfirmationEmail: jest.fn(
        (
          toEmail: string,
          fullName: string,
          correlativeNumber: string,
          claimType: string,
          pdfBuffer: Buffer,
        ) => {
          lastDispatchedMail = {
            toEmail,
            fullName,
            correlativeNumber,
            claimType,
            pdfBuffer,
          };
          return Promise.resolve();
        },
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ComplaintsController],
      providers: [
        ComplaintsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMailService },
      ],
    }).compile();

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

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('1. POST /complaints: unauthenticated citizen submits valid Reclamo (generates R-00001-YYYY & dispatches PDF email)', async () => {
    const currentYear = new Date().getFullYear();
    const payload = {
      documentType: 'DNI',
      documentNumber: '10293847',
      fullName: 'Carlos Rodriguez Silva',
      address: 'Av. Arequipa 2450, Lince, Lima',
      phone: '987123456',
      email: 'carlos.rodriguez@gmail.com',
      isMinor: false,
      goodType: 'PRODUCTO',
      goodDescription: 'Bolsas biodegradables compostables pack x50',
      amount: 65.0,
      claimType: 'RECLAMO',
      claimDetail:
        'Las bolsas entregadas no cumplían con el micraje especificado en la descripción de la tienda.',
      consumerRequest:
        'Reposición del producto por el lote de micraje correspondiente o reembolso en EcoTokens.',
    };

    const res = await request(app.getHttpServer())
      .post('/complaints')
      .send(payload)
      .expect(201);

    const body = res.body as MockComplaintRecord;
    expect(body.id).toBeDefined();
    expect(body.correlativeNumber).toBe(`R-00001-${currentYear}`);
    expect(body.documentNumber).toBe('10293847');
    expect(body.fullName).toBe('Carlos Rodriguez Silva');
    expect(body.status).toBe('OPEN');
    expect(body.userId).toBeNull();

    // Verify email dispatch with PDF attachment
    expect(lastDispatchedMail).toBeDefined();
    expect(lastDispatchedMail?.toEmail).toBe('carlos.rodriguez@gmail.com');
    expect(lastDispatchedMail?.correlativeNumber).toBe(
      `R-00001-${currentYear}`,
    );
    expect(lastDispatchedMail?.claimType).toBe('RECLAMO');
    expect(lastDispatchedMail?.pdfBuffer).toBeInstanceOf(Buffer);
    expect(lastDispatchedMail?.pdfBuffer.length).toBeGreaterThan(1000);
  });

  it('2. POST /complaints: second Reclamo increments sequential correlative to R-00002-YYYY', async () => {
    const currentYear = new Date().getFullYear();
    const payload = {
      documentType: 'CE',
      documentNumber: '001234567',
      fullName: 'Elena Vasquez',
      address: 'Calle Las Begonias 333, San Isidro',
      phone: '912345678',
      email: 'elena.vasquez@empresa.com',
      goodType: 'SERVICIO',
      goodDescription: 'Certificación digital de huella de carbono',
      amount: 250.0,
      claimType: 'RECLAMO',
      claimDetail:
        'Retraso de más de 10 días en la emisión del certificado digital.',
      consumerRequest: 'Emisión inmediata del certificado validado.',
    };

    const res = await request(app.getHttpServer())
      .post('/complaints')
      .send(payload)
      .expect(201);

    const body = res.body as MockComplaintRecord;
    expect(body.correlativeNumber).toBe(`R-00002-${currentYear}`);
  });

  it('3. POST /complaints: Queja generates independent correlative Q-00001-YYYY with minor representation', async () => {
    const currentYear = new Date().getFullYear();
    const payload = {
      documentType: 'DNI',
      documentNumber: '78945612',
      fullName: 'Mateo Quispe (Menor)',
      address: 'Av. Universitaria 1200, San Miguel',
      phone: '976543210',
      email: 'padre.quispe@gmail.com',
      isMinor: true,
      representativeName: 'Jorge Quispe (Padre)',
      goodType: 'SERVICIO',
      goodDescription: 'Atención presencial en centro de acopio San Miguel',
      claimType: 'QUEJA',
      claimDetail:
        'El personal del centro de acopio se negó a recibir material limpio en horario de atención regular.',
      consumerRequest:
        'Aclaración de horarios de atención al público y amonestación correspondiente.',
      userId: '77700000-0000-4000-8000-000000000001',
    };

    const res = await request(app.getHttpServer())
      .post('/complaints')
      .send(payload)
      .expect(201);

    const body = res.body as MockComplaintRecord;
    expect(body.correlativeNumber).toBe(`Q-00001-${currentYear}`);
    expect(body.isMinor).toBe(true);
    expect(body.representativeName).toBe('Jorge Quispe (Padre)');
    expect(body.userId).toBe('77700000-0000-4000-8000-000000000001');
  });

  it('4. POST /complaints: validation rejects invalid input data (RFC 9457 Problem Details)', async () => {
    // Missing required fields & invalid enum values
    const invalidPayload = {
      documentType: 'PASAPORTE_INVALIDO',
      documentNumber: '',
      email: 'not-an-email',
      goodType: 'OTRO_TIPO',
      claimType: 'SUGERENCIA',
    };

    const res = await request(app.getHttpServer())
      .post('/complaints')
      .send(invalidPayload)
      .expect(400);

    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.body as ProblemDetailsResponse;
    expect(body.status).toBe(400);
    expect(body.detail).toBeDefined();
  });

  it('5. GET /complaints/:id: returns full complaint data by UUID', async () => {
    const res = await request(app.getHttpServer())
      .get('/complaints/complaint-uuid-1')
      .expect(200);

    const body = res.body as MockComplaintRecord;
    expect(body.id).toBe('complaint-uuid-1');
    expect(body.fullName).toBe('Carlos Rodriguez Silva');
  });

  it('6. GET /complaints/:id: returns 404 Problem Details when ID is not found', async () => {
    const res = await request(app.getHttpServer())
      .get('/complaints/non-existent-uuid')
      .expect(404);

    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.body as ProblemDetailsResponse;
    expect(body.status).toBe(404);
  });

  it('7. GET /complaints/correlative/:correlativeNumber: returns complaint data by official correlative', async () => {
    const currentYear = new Date().getFullYear();
    const res = await request(app.getHttpServer())
      .get(`/complaints/correlative/R-00001-${currentYear}`)
      .expect(200);

    const body = res.body as MockComplaintRecord;
    expect(body.correlativeNumber).toBe(`R-00001-${currentYear}`);
    expect(body.fullName).toBe('Carlos Rodriguez Silva');
  });

  it('8. GET /complaints/:id/pdf: downloads PDF binary stream for the complaint', async () => {
    const res = await request(app.getHttpServer())
      .get('/complaints/complaint-uuid-1/pdf')
      .expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body).toBeDefined();
    // Supertest binary buffer response check
    const buffer = Buffer.isBuffer(res.body)
      ? res.body
      : Buffer.from((res.text as string | undefined) || '');
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
