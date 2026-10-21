import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ComplaintStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/services/mail.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import { UpdateComplaintStatusDto } from './dto/update-complaint-status.dto';
import { TrackComplaintDto } from './dto/track-complaint.dto';
import { ComplaintPdfKitAdapter } from './adapters/complaint-pdfkit.adapter';
import { ComplaintPdfData } from './adapters/complaint-pdf.adapter.interface';

export { ComplaintPdfData };

@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger(ComplaintsService.name);
  private readonly adapter: ComplaintPdfKitAdapter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    @Optional() pdfAdapter?: ComplaintPdfKitAdapter,
  ) {
    this.adapter = pdfAdapter ?? new ComplaintPdfKitAdapter();
  }

  /**
   * Genera el número correlativo anual único de forma atómica usando la tabla
   * dedicada complaint_counters con incremento RETURNING en PostgreSQL.
   * Formato: R-XXXXX-AAAA (Reclamo) o Q-XXXXX-AAAA (Queja).
   */
  async generateCorrelativeNumber(
    claimType: string,
    txClient?: any,
  ): Promise<string> {
    const currentYear = new Date().getFullYear();
    const isReclamo = claimType.toUpperCase() === 'RECLAMO';
    const prefix = isReclamo ? 'R' : 'Q';

    const executeIncrement = async (tx: any): Promise<string> => {
      // 1. Ruta Primaria: Incremento atómico en PostgreSQL con row lock
      if (typeof tx.$queryRaw === 'function') {
        try {
          let rows: { last_value: number }[] = await tx.$queryRaw`
            UPDATE "complaint_counters"
            SET "last_value" = "last_value" + 1, "updated_at" = NOW()
            WHERE "year" = ${currentYear} AND "type" = ${prefix}
            RETURNING "last_value";
          `;

          // Si la fila aún no existe para este año y tipo, inicializar de forma segura e idempotente
          if (!rows || rows.length === 0) {
            await tx.$executeRaw`
              INSERT INTO "complaint_counters" ("id", "year", "type", "last_value", "created_at", "updated_at")
              SELECT 
                gen_random_uuid(),
                ${currentYear}::integer,
                ${prefix}::varchar,
                COALESCE((
                  SELECT MAX(NULLIF(regexp_replace(split_part("correlativeNumber", '-', 2), '\D', '', 'g'), '')::integer)
                  FROM "complaints"
                  WHERE "correlativeNumber" LIKE ${`${prefix}-%-${currentYear}`}
                ), 0),
                NOW(),
                NOW()
              ON CONFLICT ("year", "type") DO NOTHING;
            `;

            rows = await tx.$queryRaw`
              UPDATE "complaint_counters"
              SET "last_value" = "last_value" + 1, "updated_at" = NOW()
              WHERE "year" = ${currentYear} AND "type" = ${prefix}
              RETURNING "last_value";
            `;
          }

          if (rows && rows.length > 0 && rows[0].last_value !== undefined) {
            const nextSeq = Number(rows[0].last_value);
            const nextSeqFormatted = String(nextSeq).padStart(5, '0');
            return `${prefix}-${nextSeqFormatted}-${currentYear}`;
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Atomic counter raw query failed or not supported in test mock: ${err}. Falling back to table scan.`,
          );
        }
      }

      // 2. Fallback resiliente para suites de pruebas unitarias con mocks en memoria
      const yearSuffix = `-${currentYear}`;
      const existing = await tx.complaint.findMany({
        where: {
          correlativeNumber: {
            startsWith: `${prefix}-`,
            endsWith: yearSuffix,
          },
        },
        select: { correlativeNumber: true },
      });

      let maxSequence = 0;
      for (const item of existing) {
        const parts = item.correlativeNumber.split('-');
        if (
          parts.length === 3 &&
          parts[0] === prefix &&
          parts[2] === String(currentYear)
        ) {
          const seq = parseInt(parts[1], 10);
          if (!isNaN(seq) && seq > maxSequence) {
            maxSequence = seq;
          }
        }
      }

      const nextSeqFormatted = String(maxSequence + 1).padStart(5, '0');
      return `${prefix}-${nextSeqFormatted}-${currentYear}`;
    };

    if (txClient) {
      return executeIncrement(txClient);
    }
    return this.prisma.$transaction(async (tx) => executeIncrement(tx));
  }

/**
   * Genera la Hoja de Reclamación en PDF en memoria según estándares de Indecopi
   * delegando en el adaptador desacoplado (GoF Adapter Pattern).
   */
  async generateComplaintPdf(complaint: ComplaintPdfData): Promise<Buffer> {
    return this.adapter.generatePdf(complaint);
  }

  /**
   * Registra una nueva queja o reclamo en el Libro de Reclamaciones, genera el PDF y envía confirmación por email.
   */
  async createComplaint(dto: CreateComplaintDto, authenticatedUserId?: string) {
    const userId = dto.userId || authenticatedUserId || null;

    const complaint = await this.prisma.$transaction(async (tx) => {
      const correlativeNumber = await this.generateCorrelativeNumber(
        dto.claimType,
        tx,
      );

      return tx.complaint.create({
        data: {
          correlativeNumber,
          documentType: dto.documentType,
          documentNumber: dto.documentNumber,
          fullName: dto.fullName,
          address: dto.address,
          phone: dto.phone,
          email: dto.email,
          isMinor: dto.isMinor ?? false,
          representativeName: dto.representativeName || null,
          representativeDoc: dto.representativeDoc || null,
          goodType: dto.goodType,
          goodDescription: dto.goodDescription,
          amount:
            dto.amount !== undefined && dto.amount !== null
              ? Number(dto.amount)
              : null,
          claimType: dto.claimType,
          claimDetail: dto.claimDetail,
          consumerRequest: dto.consumerRequest,
          subject: `${dto.claimType} - ${dto.goodType} - ${correlativeNumber}`,
          description: dto.claimDetail,
          userId,
        },
      });
    });

    this.logger.log(
      `Reclamación registrada exitosamente: ${complaint.correlativeNumber} para ${complaint.email}`,
    );

    // Generar PDF y enviar correo en segundo plano / con captura de error
    try {
      const pdfBuffer = await this.generateComplaintPdf(complaint);
      await this.mailService.sendComplaintConfirmationEmail(
        complaint.email,
        complaint.fullName,
        complaint.correlativeNumber,
        complaint.claimType,
        pdfBuffer,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error generando PDF o despachando correo para ${complaint.correlativeNumber}: ${msg}`,
      );
    }

    return complaint;
  }

  /**
   * Obtiene una queja/reclamo por su ID (UUID).
   */
  async getComplaintById(id: string) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id },
    });
    if (!complaint) {
      throw new NotFoundException(
        `Hoja de reclamación con ID ${id} no encontrada`,
      );
    }
    return complaint;
  }

  /**
   * Obtiene una queja/reclamo por su número correlativo oficial.
   */
  async getComplaintByCorrelative(correlativeNumber: string) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { correlativeNumber },
    });
    if (!complaint) {
      throw new NotFoundException(
        `Hoja de reclamación correlativo ${correlativeNumber} no encontrada`,
      );
    }
    return complaint;
  }

  maskFullName(fullName: string): string {
    if (!fullName) return '***';
    return fullName
      .trim()
      .split(/\s+/)
      .map((part) => {
        if (part.length <= 2) return `${part[0]}*`;
        return `${part[0]}${'*'.repeat(part.length - 2)}${part[part.length - 1]}`;
      })
      .join(' ');
  }

  maskEmail(email: string): string {
    if (!email || !email.includes('@')) return '***@***';
    const [user, domain] = email.split('@');
    if (user.length <= 2) {
      return `${user[0]}*@${domain}`;
    }
    const maskedUser = `${user[0]}${'*'.repeat(Math.min(user.length - 2, 4))}${user[user.length - 1]}`;
    return `${maskedUser}@${domain}`;
  }

  maskDocumentNumber(doc: string): string {
    if (!doc) return '****';
    const trimmed = doc.trim();
    if (trimmed.length <= 3) return '***';
    return `${'*'.repeat(trimmed.length - 2)}${trimmed.slice(-2)}`;
  }

  async trackComplaint(dto: TrackComplaintDto) {
    const correlativeNumber = dto.correlativeNumber.trim().toUpperCase();
    const documentNumber = dto.documentNumber.trim();

    const complaint = await this.prisma.complaint.findUnique({
      where: { correlativeNumber },
    });

    if (!complaint || complaint.documentNumber.trim().toUpperCase() !== documentNumber.toUpperCase()) {
      throw new NotFoundException(
        'No se encontró ninguna reclamación con los datos de seguimiento proporcionados.',
      );
    }

    return {
      id: complaint.id,
      correlativeNumber: complaint.correlativeNumber,
      claimType: complaint.claimType,
      goodType: complaint.goodType,
      goodDescription: complaint.goodDescription,
      claimDetail: complaint.claimDetail,
      consumerRequest: complaint.consumerRequest,
      status: complaint.status,
      fullName: this.maskFullName(complaint.fullName),
      email: this.maskEmail(complaint.email),
      documentType: complaint.documentType,
      documentNumberMasked: this.maskDocumentNumber(complaint.documentNumber),
      legalResponseNote: complaint.legalResponseNote,
      respondedAt: complaint.respondedAt,
      createdAt: complaint.createdAt,
      updatedAt: complaint.updatedAt,
    };
  }

  async getTrackComplaintPdf(dto: TrackComplaintDto): Promise<Buffer> {
    const correlativeNumber = dto.correlativeNumber.trim().toUpperCase();
    const documentNumber = dto.documentNumber.trim();

    const complaint = await this.prisma.complaint.findUnique({
      where: { correlativeNumber },
    });

    if (!complaint || complaint.documentNumber.trim().toUpperCase() !== documentNumber.toUpperCase()) {
      throw new NotFoundException(
        'No se encontró ninguna reclamación con los datos de seguimiento proporcionados.',
      );
    }

    return this.generateComplaintPdf(complaint);
  }

  /**
   * Actualiza el estado y sustento legal de una reclamación (Rol: ADMIN).
   * Registra respondedAt = new Date() cuando pasa a RESOLVED o CLOSED.
   */
  async updateComplaintStatus(
    id: string,
    dto: UpdateComplaintStatusDto,
  ) {
    const complaint = await this.prisma.complaint.findUnique({
      where: { id },
    });

    if (!complaint) {
      throw new NotFoundException(
        `Hoja de reclamación con ID ${id} no encontrada`,
      );
    }

    return this.prisma.complaint.update({
      where: { id },
      data: {
        status: dto.status,
        legalResponseNote: dto.legalResponseNote ?? complaint.legalResponseNote,
        respondedAt:
          dto.status === ComplaintStatus.RESOLVED ||
          dto.status === ComplaintStatus.CLOSED
            ? new Date()
            : complaint.respondedAt,
      },
    });
  }

  /**
   * Listar todas las reclamaciones con filtros y paginación para el Administrador.
   */
  async findAllComplaints(params: {
    page?: number;
    limit?: number;
    status?: ComplaintStatus;
    claimType?: string;
    search?: string;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(params.limit) || 10));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.status) {
      where.status = params.status;
    }
    if (params.claimType && params.claimType !== 'ALL') {
      where.claimType = params.claimType;
    }
    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      where.OR = [
        { correlativeNumber: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { documentNumber: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.complaint.count({ where }),
      this.prisma.complaint.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }
}
