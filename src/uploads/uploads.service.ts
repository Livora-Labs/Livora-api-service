import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { R2StorageService } from '../storage/r2-storage.service';
import { validateMagicBytes } from './utils/magic-bytes.util';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PURPOSES = ['collection', 'kyc', 'receipt', 'store'] as const;
type PurposeType = typeof PURPOSES[number];

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly storageService: R2StorageService) {}

  async upload(file: Express.Multer.File, purposeRaw?: string, userId?: string) {
    if (!file || !file.buffer) {
      throw new BadRequestException(
        'No se recibió ningún archivo válido en el campo "file"',
      );
    }

    const purpose: PurposeType = PURPOSES.includes(purposeRaw as any)
      ? (purposeRaw as PurposeType)
      : 'collection';

    if (file.size > MAX_BYTES) {
      throw new BadRequestException('El archivo supera el límite máximo de 10 MB');
    }

    const detected = validateMagicBytes(file.buffer);
    if (!detected) {
      throw new BadRequestException(
        'Firma binaria no válida. Solo se admiten archivos genuinos PDF, JPEG o PNG.',
      );
    }

    if (purpose !== 'kyc' && detected.mime === 'application/pdf') {
      throw new BadRequestException(
        'Los archivos PDF solo están permitidos para el propósito KYC.',
      );
    }

    const safeFilename = `${randomUUID()}.${detected.extension}`;

    if (purpose === 'kyc') {
      const path = `kyc/${userId || 'general'}/${safeFilename}`;
      const result = await this.storageService.upload(path, file.buffer, {
        contentType: detected.mime,
        isPublic: false,
      });

      return {
        url: result.url,
        path: result.path,
        purpose,
        mimeType: detected.mime,
        size: file.size,
        expiresIn: result.expiresIn || 900,
      };
    }

    const path = `${purpose}/${safeFilename}`;
    const result = await this.storageService.upload(path, file.buffer, {
      contentType: detected.mime,
      isPublic: true,
    });

    return {
      url: result.url,
      path: result.path,
      purpose,
      mimeType: detected.mime,
      size: file.size,
    };
  }

  async getPresignedKycUrl(path: string, expiresInSeconds = 900): Promise<string> {
    return this.storageService.getSignedUrl(path, expiresInSeconds);
  }

  /**
   * Refresca determinísticamente un enlace KYC firmado si ha expirado.
   * Si es IPFS (ipfs:// o hash CID), lo normaliza a gateway HTTPS propio o público.
   */
  async getFreshSignedUrl(urlOrPath?: string | null): Promise<string | null> {
    if (!urlOrPath) return null;
    const trimmed = urlOrPath.trim();
    if (!trimmed) return null;

    // Normalizar IPFS
    if (trimmed.startsWith('ipfs://')) {
      const cid = trimmed.replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
      return `https://ipfs.grupolivoralabs.com/ipfs/${cid}`;
    }
    if (/^Qm[1-9A-HJ-NP-za-km-z]{44}/.test(trimmed) || /^bafy[a-z0-9]{55}/.test(trimmed)) {
      return `https://ipfs.grupolivoralabs.com/ipfs/${trimmed}`;
    }

    // Si es ruta privada KYC de R2 o contiene prefijo kyc/
    if (trimmed.includes('kyc/') || trimmed.startsWith('kyc/')) {
      try {
        let storagePath = trimmed;
        if (trimmed.includes('kyc/')) {
          storagePath = 'kyc/' + trimmed.split('kyc/')[1].split('?')[0];
        }
        return await this.storageService.getSignedUrl(storagePath, 900);
      } catch (e: any) {
        this.logger.warn(`Error refrescando signed URL para KYC: ${e.message}`);
      }
    }

    return trimmed;
  }

  async getFileStream(path: string) {
    return this.storageService.getFile(path);
  }
}
