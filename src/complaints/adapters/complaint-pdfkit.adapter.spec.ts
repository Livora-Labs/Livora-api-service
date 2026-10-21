import { ComplaintPdfKitAdapter } from './complaint-pdfkit.adapter';
import { ComplaintPdfData } from './complaint-pdf.adapter.interface';

describe('Patrón Adaptador: ComplaintPdfKitAdapter (PUCP Disoft Diapositivas 04-06)', () => {
  let adapter: ComplaintPdfKitAdapter;

  beforeEach(() => {
    adapter = new ComplaintPdfKitAdapter();
  });

  it('debe generar un buffer binario PDF válido a partir de datos de reclamación', async () => {
    const data: ComplaintPdfData = {
      correlativeNumber: 'R-00001-2026',
      fullName: 'Carlos Alcántara',
      documentType: 'DNI',
      documentNumber: '10293847',
      phone: '987654321',
      email: 'carlos@ejemplo.pe',
      address: 'Av. Brasil 1234, Jesús María',
      isMinor: false,
      goodType: 'SERVICIO',
      goodDescription: 'Retiro domiciliario de reciclaje',
      amount: 45.0,
      claimType: 'RECLAMO',
      claimDetail: 'Retraso injustificado de recolector',
      consumerRequest: 'Devolución de penalización y disculpas',
      createdAt: new Date(),
    };

    const pdfBuffer = await adapter.generatePdf(data);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // Validación de firma de archivo PDF (%PDF-)
    expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('debe generar el PDF correctamente para reclamos de menores de edad con representante', async () => {
    const data: ComplaintPdfData = {
      correlativeNumber: 'Q-00002-2026',
      fullName: 'Mateo Quispe',
      documentType: 'DNI',
      documentNumber: '76543210',
      phone: '912345678',
      email: 'padre@ejemplo.pe',
      address: 'Calle Los Álamos 456, San Borja',
      isMinor: true,
      representativeName: 'Lucía Quispe (Madre)',
      representativeDoc: 'DNI 08765432',
      goodType: 'PRODUCTO',
      goodDescription: 'Canje de bolsa ecológica en tienda',
      claimType: 'QUEJA',
      claimDetail: 'Mala atención en tienda asociada',
      consumerRequest: 'Capacitación al personal',
    };

    const pdfBuffer = await adapter.generatePdf(data);

    expect(pdfBuffer).toBeInstanceOf(Buffer);
    expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
