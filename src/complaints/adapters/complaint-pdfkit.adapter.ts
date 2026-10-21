import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  ComplaintPdfData,
  IComplaintPdfAdapter,
} from './complaint-pdf.adapter.interface';

const PROVIDER_INFO = {
  businessName: 'LIVORA LABS S.A.C.',
  ruc: '20612345678',
  address: 'Av. Universitaria 1801, San Miguel, Lima, Perú',
  web: 'https://livora.pe',
  email: 'soporte@grupolivoralabs.com',
};

/**
 * Patrón Adaptador Concreto (PUCP Disoft - Adapter Pattern)
 * Adapta la librería externa de bajo nivel PDFKit a la interfaz IComplaintPdfAdapter
 * requerida por el dominio de Reclamaciones Indecopi.
 */
@Injectable()
export class ComplaintPdfKitAdapter implements IComplaintPdfAdapter {
  async generatePdf(complaint: ComplaintPdfData): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 40, size: 'A4', compress: false });
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
        doc.text(`Tipo: ${complaint.claimType}`);
        doc.text(`Detalle: ${complaint.claimDetail}`);
        doc.moveDown(0.4);
        doc.text(`Pedido Concreto: ${complaint.consumerRequest}`);
        doc.moveDown(1.2);

        // Advertencia Legal Indecopi (Ley 29571)
        doc.rect(40, doc.y, 515, 45).fill('#FFF3E0');
        doc
          .fillColor('#E65100')
          .fontSize(8)
          .text(
            'IMPORTANTE: La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es vía previa para interponer una denuncia ante el INDECOPI.',
            50,
            doc.y - 38,
            { width: 495 },
          );
        doc.text(
          'El proveedor deberá dar respuesta al reclamo en un plazo no mayor a quince (15) días hábiles improrrogables.',
          50,
          doc.y + 4,
          { width: 495 },
        );

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}
