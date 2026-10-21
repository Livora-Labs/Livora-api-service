/**
 * Patrón Adaptador (Adapter Pattern) - PUCP Disoft Diapositiva 04-06
 * Interfaz objetivo para generadores de documentos PDF regulatorios de Indecopi.
 */

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
  amount?: number | any | null;
  claimType: string;
  claimDetail: string;
  consumerRequest: string;
  createdAt?: Date | string | null;
}

export interface IComplaintPdfAdapter {
  generatePdf(complaint: ComplaintPdfData): Promise<Buffer>;
}
