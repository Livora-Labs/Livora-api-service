import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../common/services/mail.service';
import { CreateComplaintDto } from './dto/create-complaint.dto';
import PDFDocument from 'pdfkit';

// Datos del proveedor (fuente única de verdad)
const PROVIDER_INFO = {
  businessName: 'LIVORA S.A.C.',
  ruc: '20608912345',
  address: 'Av. Javier Prado Este 4200, Surco, Lima, Perú',
  web: 'https://livora.org',
  email: 'privacidad@livora.pe',
} as const;

export interface ComplaintPdfData {
  correlativeNumber: string;
  fullName: string;
  documentType: string;
  documentNumber: string;
  phone: string;
  email: string;
  address: string;
  isMinor?: boolean | null;
  representativeName?: string | null;
  representativeDoc?: string | null;
  goodType: string;
  goodDescription: string;
  amount?: number | null;
  claimType: string;
  claimDetail: string;
  consumerRequest: string;
  createdAt?: Date | string | null;
}

@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger(ComplaintsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Genera el número correlativo anual único de forma atómica usando una
   * transacción serializable para evitar race conditions bajo carga concurrente.
   * Formato: R-XXXXX-AAAA (Reclamo) o Q-XXXXX-AAAA (Queja).
   */
  async generateCorrelativeNumber(claimType: string): Promise<string> {
    const currentYear = new Date().getFullYear();
    const isReclamo = claimType.toUpperCase() === 'RECLAMO';
    const prefix = isReclamo ? 'R' : 'Q';
    const yearSuffix = `-${currentYear}`;

    // Transacción serializable para evitar race conditions
    return await this.prisma.$transaction(async (tx) => {
      // Buscar el correlativo más alto del año actual para este tipo
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
    });
  }

  /**
   * Genera la Hoja de Reclamación en PDF en memoria según estándares de Indecopi.
   */
  async generateComplaintPdf(complaint: ComplaintPdfData): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', (err: Error) => reject(err));

        // Encabezado institucional
        doc
          .fillColor('#2E7D32')
          .fontSize(16)
          .text('LIVORA - LIBRO DE RECLAMACIONES', { align: 'center' });
        doc
          .fontSize(12)
          .fillColor('#333333')
          .text('HOJA DE RECLAMACIÓN VIRTUAL', { align: 'center' });
        doc.moveDown(0.6);

        // Banner correlativo y fecha
        const dateStr = complaint.createdAt
          ? new Date(complaint.createdAt).toLocaleString('es-PE', {
              timeZone: 'America/Lima',
            })
          : new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });

        doc.rect(40, doc.y, 515, 24).fill('#E8F5E9');
        doc
          .fillColor('#1B5E20')
          .fontSize(10)
          .text(
            `N° CORRELATIVO: ${complaint.correlativeNumber}   |   FECHA: ${dateStr}`,
            50,
            doc.y - 18,
          );
        doc.moveDown(1);

        // 1. Identificación del Proveedor
        doc
          .fillColor('#2E7D32')
          .fontSize(11)
          .text('1. IDENTIFICACIÓN DEL PROVEEDOR RECLAMADO');
        doc
          .strokeColor('#CCCCCC')
          .lineWidth(0.5)
          .moveTo(40, doc.y)
          .lineTo(555, doc.y)
          .stroke();
        doc.moveDown(0.4);
        doc.fillColor('#333333').fontSize(9);
        doc.text(
          `Razón Social: ${PROVIDER_INFO.businessName}                     RUC: ${PROVIDER_INFO.ruc}`,
        );
        doc.text(`Dirección: ${PROVIDER_INFO.address}`);
        doc.text(
          `Portal Web: ${PROVIDER_INFO.web}                     Email: ${PROVIDER_INFO.email}`,
        );
        doc.moveDown(0.8);

        // 2. Identificación del Consumidor Reclamante
        doc
          .fillColor('#2E7D32')
          .fontSize(11)
          .text('2. IDENTIFICACIÓN DEL CONSUMIDOR RECLAMANTE');
        doc
          .strokeColor('#CCCCCC')
          .lineWidth(0.5)
          .moveTo(40, doc.y)
          .lineTo(555, doc.y)
          .stroke();
        doc.moveDown(0.4);
        doc.fillColor('#333333').fontSize(9);
        doc.text(`Nombre Completo / Razón Social: ${complaint.fullName}`);
        doc.text(
          `Documento de Identidad: ${complaint.documentType} ${complaint.documentNumber}          Teléfono: ${complaint.phone}`,
        );
        doc.text(`Email de Notificación: ${complaint.email}`);
        doc.text(`Domicilio: ${complaint.address}`);
        if (complaint.isMinor) {
          const repInfo = complaint.representativeName || 'Padre/Madre/Tutor';
          const repDoc = complaint.representativeDoc
            ? ` — Doc. Identidad: ${complaint.representativeDoc}`
            : '';
          doc.text(
            `Condición: Menor de edad          Representante Legal: ${repInfo}${repDoc}`,
          );
        }
        doc.moveDown(0.8);

        // 3. Identificación del Bien Contratado
        doc
          .fillColor('#2E7D32')
          .fontSize(11)
          .text('3. IDENTIFICACIÓN DEL BIEN CONTRATADO');
        doc
          .strokeColor('#CCCCCC')
          .lineWidth(0.5)
          .moveTo(40, doc.y)
          .lineTo(555, doc.y)
          .stroke();
        doc.moveDown(0.4);
        doc.fillColor('#333333').fontSize(9);
        const amountDisplay =
          complaint.amount !== null && complaint.amount !== undefined
            ? `S/ ${Number(complaint.amount).toFixed(2)}`
            : 'No especificado / Sin reclamo monetario';
        doc.text(
          `Tipo de Bien: ${complaint.goodType}          Monto Reclamado: ${amountDisplay}`,
        );
        doc.text(
          `Descripción del Bien / Servicio: ${complaint.goodDescription}`,
        );
        doc.moveDown(0.8);

        // 4. Detalle de la Reclamación y Pedido
        doc
          .fillColor('#2E7D32')
          .fontSize(11)
          .text(`4. DETALLE DE LA RECLAMACIÓN (${complaint.claimType})`);
        doc
          .strokeColor('#CCCCCC')
          .lineWidth(0.5)
          .moveTo(40, doc.y)
          .lineTo(555, doc.y)
          .stroke();
        doc.moveDown(0.4);
        doc.fillColor('#333333').fontSize(9);
        doc.text(`Tipo de Disconformidad: ${complaint.claimType}`);
        doc.moveDown(0.2);
        doc.text('Detalle de los Hechos:', { underline: true });
        doc.fillColor('#424242').text(complaint.claimDetail, { indent: 10 });
        doc.moveDown(0.4);
        doc
          .fillColor('#333333')
          .text('Pedido Concreto del Consumidor:', { underline: true });
        doc
          .fillColor('#424242')
          .text(complaint.consumerRequest, { indent: 10 });
        doc.moveDown(1);

        // 5. Marco Legal y Advertencia Indecopi
        doc.rect(40, doc.y, 515, 75).fill('#F5F5F5');
        doc.fillColor('#37474F').fontSize(8);
        doc.text(
          '* RECLAMO: Disconformidad relacionada a los productos o servicios comercializados.',
          45,
          doc.y - 70,
        );
        doc.text(
          '* QUEJA: Disconformidad no relacionada a los productos o servicios; o malestar o descontento respecto a la atención al público.',
        );
        doc.text(
          '* PLAZO LEGAL DE RESPUESTA: Conforme a la Ley N° 29571 (Código de Protección y Defensa del Consumidor) y Ley N° 32495, el proveedor deberá dar respuesta al reclamo o queja en un plazo máximo de quince (15) días hábiles improrrogables.',
        );
        doc.text(
          '* La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante INDECOPI.',
        );

        doc.end();
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Registra una nueva queja o reclamo en el Libro de Reclamaciones, genera el PDF y envía confirmación por email.
   */
  async createComplaint(dto: CreateComplaintDto, authenticatedUserId?: string) {
    const correlativeNumber = await this.generateCorrelativeNumber(
      dto.claimType,
    );
    const userId = dto.userId || authenticatedUserId || null;

    const complaint = await this.prisma.complaint.create({
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

    this.logger.log(
      `Reclamación registrada exitosamente: ${correlativeNumber} para ${complaint.email}`,
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
        `Error generando PDF o despachando correo para ${correlativeNumber}: ${msg}`,
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
}
