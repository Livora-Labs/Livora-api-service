import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import request from 'supertest';
import {
  GlobalExceptionFilter,
  ProblemDetails,
} from '../src/common/filters/global-exception.filter';
import { CollectionsController } from '../src/collections/collections.controller';
import { CollectionsService } from '../src/collections/collections.service';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { Role, RequestStatus } from '@prisma/client';

describe('Fastify Multipart & CollectionsController (e2e)', () => {
  let app: NestFastifyApplication;

  const mockCollectionsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    updateStatus: jest.fn(),
    verifyPin: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CollectionsController],
      providers: [
        {
          provide: CollectionsService,
          useValue: mockCollectionsService,
        },
      ],
    })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = {
            id: 'household-uuid-1',
            role: Role.HOGAR,
            email: 'hogar@livora.org',
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );

    await app.register(fastifyMultipart, {
      attachFieldsToBody: 'keyValues',
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      async onFile(part: any) {
        const buffer = await part.toBuffer();
        (this as any).incomingFile = {
          originalname: part.filename,
          mimetype: part.mimetype,
          buffer,
          size: buffer.length,
        };
      },
    });

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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('1. POST /collection-requests with JSON body creates collection request successfully', async () => {
    const mockCreated = {
      id: 'req-json-1',
      status: RequestStatus.PENDING,
      itemsEstimated: { PET: 2.5, GLASS: 1.0 },
      description: 'Materiales clasificados',
      latitude: -12.0464,
      longitude: -77.0428,
      householdId: 'household-uuid-1',
    };
    mockCollectionsService.create.mockResolvedValue(mockCreated);

    const res = await request(app.getHttpServer())
      .post('/collection-requests')
      .send({
        itemsEstimated: { PET: 2.5, GLASS: 1.0 },
        description: 'Materiales clasificados',
        latitude: -12.0464,
        longitude: -77.0428,
      })
      .expect(201);

    expect(res.body).toEqual(mockCreated);
    expect(mockCollectionsService.create).toHaveBeenCalledWith(
      'household-uuid-1',
      {
        itemsEstimated: { PET: 2.5, GLASS: 1.0 },
        description: 'Materiales clasificados',
        latitude: -12.0464,
        longitude: -77.0428,
      },
      undefined,
    );
  });

  it('2. POST /collection-requests with multipart/form-data and file creates request without ValidationPipe failure', async () => {
    const mockCreated = {
      id: 'req-multipart-1',
      status: RequestStatus.PENDING,
      itemsEstimated: { PET: 3.5 },
      description: 'Bolsa blanca afuera',
      latitude: -12.04,
      longitude: -77.04,
      photoUrl: 'https://ipfs.io/ipfs/QmDummyCid',
      householdId: 'household-uuid-1',
    };
    mockCollectionsService.create.mockResolvedValue(mockCreated);

    const res = await request(app.getHttpServer())
      .post('/collection-requests')
      .field('itemsEstimated', '{"PET": 3.5}')
      .field('description', 'Bolsa blanca afuera')
      .field('latitude', '-12.04')
      .field('longitude', '-77.04')
      .attach('file', Buffer.from('fake image content'), 'reciclaje.jpg')
      .expect(201);

    expect(res.body).toEqual(mockCreated);
    expect(mockCollectionsService.create).toHaveBeenCalledWith(
      'household-uuid-1',
      expect.objectContaining({
        itemsEstimated: { PET: 3.5 },
        description: 'Bolsa blanca afuera',
        latitude: -12.04,
        longitude: -77.04,
      }),
      expect.objectContaining({
        originalname: 'reciclaje.jpg',
        mimetype: 'image/jpeg',
      }),
    );
  });

  it('3. POST /collection-requests with invalid multipart payload returns RFC 9457 400 Problem Details', async () => {
    const res = await request(app.getHttpServer())
      .post('/collection-requests')
      .field('itemsEstimated', 'not-a-json-object')
      .field('latitude', 'invalid-lat')
      .expect(400);

    const body = res.body as ProblemDetails;
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.status).toBe(400);
    expect(body.type).toBe('https://api.livora.org/errors/bad_request');
    expect(Array.isArray(body.invalid_params)).toBe(true);
  });
});
