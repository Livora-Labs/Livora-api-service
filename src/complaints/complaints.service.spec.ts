import { Test, TestingModule } from '@nestjs/testing';
import { ComplaintsService, ComplaintPdfData } from './complaints.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/services/mail.service';
import { NotFoundException } from '@nestjs/common';
import { CreateComplaintDto } from './dto/create-complaint.dto';

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
  subject?: string;
  description?: string;
  userId?: string | null;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

describe('ComplaintsService', () => {
  let service: ComplaintsService;
  let prismaMock: any;
  let mailServiceMock: {
    sendComplaintConfirmationEmail: jest.Mock<
      Promise<void>,
      [string, string, string, string, Buffer]
    >;
  };

  const mockComplaintsTable: MockComplaintRecord[] = [];

  beforeEach(async () => {
    mockComplaintsTable.length = 0;

    prismaMock = {
      complaint: {
        findMany: jest.fn(
          ({
            where,
          }: {
            where?: {
              correlativeNumber?: { startsWith?: string; endsWith?: string };
            };
          }) => {
            const results = mockComplaintsTable.filter((c) => {
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
            return Promise.resolve(results);
          },
        ),
        create: jest.fn(({ data }: { data: Partial<MockComplaintRecord> }) => {
          const record: MockComplaintRecord = {
            id: `complaint-uuid-${mockComplaintsTable.length + 1}`,
            correlativeNumber: data.correlativeNumber || '',
            ...data,
            status: 'OPEN',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockComplaintsTable.push(record);
          return Promise.resolve(record);
        }),
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: { id?: string; correlativeNumber?: string };
          }) => {
            if (where.id) {
              return Promise.resolve(
                mockComplaintsTable.find((c) => c.id === where.id) || null,
              );
            }
            if (where.correlativeNumber) {
              return Promise.resolve(
                mockComplaintsTable.find(
                  (c) => c.correlativeNumber === where.correlativeNumber,
                ) || null,
              );
            }
            return Promise.resolve(null);
          },
        ),
      },
      // Mock de $transaction: ejecuta el callback pasándole el propio mock como tx
      $transaction: jest.fn((callback: (tx: any) => Promise<any>) =>
        callback({
          complaint: {
            findMany: jest.fn(
              ({
                where,
              }: {
                where?: {
                  correlativeNumber?: { startsWith?: string; endsWith?: string };
                };
              }) => {
                const results = mockComplaintsTable.filter((c) => {
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
                    !c.correlativeNumber.endsWith(
                      where.correlativeNumber.endsWith,
                    )
                  ) {
                    return false;
                  }
                  return true;
                });
                return Promise.resolve(results);
              },
            ),
          },
        })
      ),
    };

    mailServiceMock = {
      sendComplaintConfirmationEmail: jest.fn(
        (_email: string, _name: string, _correlative: string, _type: string, _pdf: Buffer) =>
          Promise.resolve()
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplaintsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

    service = module.get<ComplaintsService>(ComplaintsService);
  });

  it('1. should generate annual sequential correlative starting from 00001 with R- prefix for RECLAMO', async () => {
    const currentYear = new Date().getFullYear();
    const correlative1 = await service.generateCorrelativeNumber('RECLAMO');
    expect(correlative1).toBe(`R-00001-${currentYear}`);

    mockComplaintsTable.push({
      id: 'mock-1',
      correlativeNumber: `R-00001-${currentYear}`,
    });

    const correlative2 = await service.generateCorrelativeNumber('RECLAMO');
    expect(correlative2).toBe(`R-00002-${currentYear}`);
  });

  it('2. should generate annual sequential correlative starting from 00001 with Q- prefix for QUEJA independently', async () => {
    const currentYear = new Date().getFullYear();
    // Simulate existing Reclamos
    mockComplaintsTable.push({
      id: 'mock-1',
      correlativeNumber: `R-00001-${currentYear}`,
    });
    mockComplaintsTable.push({
      id: 'mock-2',
      correlativeNumber: `R-00002-${currentYear}`,
    });

    // Queja should still start at 00001
    const correlativeQ1 = await service.generateCorrelativeNumber('QUEJA');
    expect(correlativeQ1).toBe(`Q-00001-${currentYear}`);

    mockComplaintsTable.push({
      id: 'mock-3',
      correlativeNumber: `Q-00001-${currentYear}`,
    });
    const correlativeQ2 = await service.generateCorrelativeNumber('QUEJA');
    expect(correlativeQ2).toBe(`Q-00002-${currentYear}`);
  });

  it('3. should generate PDF buffer with PDFKit containing Indecopi complaint summary', async () => {
    const currentYear = new Date().getFullYear();
    const sampleComplaint: ComplaintPdfData = {
      correlativeNumber: `R-00001-${currentYear}`,
      documentType: 'DNI',
      documentNumber: '12345678',
      fullName: 'Juan Perez',
      address: 'Av. Larco 123, Miraflores',
      phone: '987654321',
      email: 'juan.perez@example.com',
      isMinor: false,
      representativeName: null,
      goodType: 'PRODUCTO',
      goodDescription: 'Compostera ecológica 20L',
      amount: 150.0,
      claimType: 'RECLAMO',
      claimDetail:
        'El producto llegó con una fisura en la tapa superior impidiendo el cierre hermético.',
      consumerRequest:
        'Cambio inmediato del producto o devolución del importe.',
      createdAt: new Date(),
    };

    const pdfBuffer = await service.generateComplaintPdf(sampleComplaint);
    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // Verify PDF header magic bytes '%PDF'
    expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('4. should create a complaint, persist in database, generate PDF, and dispatch confirmation email', async () => {
    const currentYear = new Date().getFullYear();
    const dto: CreateComplaintDto = {
      documentType: 'DNI',
      documentNumber: '87654321',
      fullName: 'Maria Rodriguez',
      address: 'Calle San Martin 456, San Isidro',
      phone: '912345678',
      email: 'maria.rodriguez@example.com',
      isMinor: false,
      goodType: 'SERVICIO',
      goodDescription: 'Servicio de recolección de reciclaje domiciliario',
      amount: 45.5,
      claimType: 'RECLAMO',
      claimDetail:
        'El recolector no asistió en el horario programado acordado en la app.',
      consumerRequest:
        'Reprogramación prioritaria del recojo y compensación de EcoTokens.',
    };

    const result = await service.createComplaint(dto);

    expect(result).toBeDefined();
    expect(result.correlativeNumber).toBe(`R-00001-${currentYear}`);
    expect(result.fullName).toBe('Maria Rodriguez');
    expect(result.status).toBe('OPEN');
    expect(result.userId).toBeNull();

    expect(mailServiceMock.sendComplaintConfirmationEmail).toHaveBeenCalledWith(
      'maria.rodriguez@example.com',
      'Maria Rodriguez',
      `R-00001-${currentYear}`,
      'RECLAMO',
      expect.any(Buffer),
    );
  });

  it('5. should support minor consumer representation and optional userId', async () => {
    const currentYear = new Date().getFullYear();
    const dto: CreateComplaintDto = {
      documentType: 'DNI',
      documentNumber: '76543210',
      fullName: 'Pedro Gomez Jr.',
      address: 'Jr. Huancavelica 789, Lima',
      phone: '999888777',
      email: 'padre.gomez@example.com',
      isMinor: true,
      representativeName: 'Carlos Gomez (Padre)',
      goodType: 'PRODUCTO',
      goodDescription: 'Kit de reciclaje escolar',
      claimType: 'QUEJA',
      claimDetail:
        'Trato inadecuado por parte del personal de atención en el punto de acopio.',
      consumerRequest:
        'Capacitación al personal en atención al cliente y disculpas formales.',
      userId: '45600000-0000-4000-8000-000000000000',
    };

    const result = await service.createComplaint(dto);
    expect(result.correlativeNumber).toBe(`Q-00001-${currentYear}`);
    expect(result.isMinor).toBe(true);
    expect(result.representativeName).toBe('Carlos Gomez (Padre)');
    expect(result.userId).toBe('45600000-0000-4000-8000-000000000000');
  });

  it('6. should find complaint by ID or throw NotFoundException', async () => {
    mockComplaintsTable.push({
      id: 'target-uuid-999',
      correlativeNumber: 'R-00099-2026',
      fullName: 'Ana Torres',
    });

    const found = await service.getComplaintById('target-uuid-999');
    expect(found.id).toBe('target-uuid-999');

    await expect(service.getComplaintById('non-existent-uuid')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('7. should find complaint by correlative number or throw NotFoundException', async () => {
    mockComplaintsTable.push({
      id: 'target-uuid-888',
      correlativeNumber: 'R-00077-2026',
      fullName: 'Carlos Diaz',
    });

    const found = await service.getComplaintByCorrelative('R-00077-2026');
    expect(found.id).toBe('target-uuid-888');

    await expect(
      service.getComplaintByCorrelative('R-99999-2026'),
    ).rejects.toThrow(NotFoundException);
  });
});
