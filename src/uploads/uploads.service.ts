import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { validateMagicBytes } from './utils/magic-bytes.util';

const DEFAULT_PUBLIC_BUCKET = 'livora-uploads';
const DEFAULT_KYC_BUCKET = 'livora-kyc-private';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PURPOSES = ['collection', 'kyc', 'receipt'] as const;
type PurposeType = typeof PURPOSES[number];

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);
  private readonly client: SupabaseClient;
  private readonly publicBucket: string;
  private readonly kycBucket: string;

  constructor(private readonly configService: ConfigService) {
    this.publicBucket =
      this.configService.get<string>('SUPABASE_STORAGE_BUCKET') ||
      DEFAULT_PUBLIC_BUCKET;
    this.kycBucket =
      this.configService.get<string>('SUPABASE_STORAGE_KYC_BUCKET') ||
      DEFAULT_KYC_BUCKET;

    this.client = createClient(
      this.configService.get<string>('SUPABASE_URL') || '',
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  async onModuleInit() {
    await this.ensureBucket(this.publicBucket, true);
    await this.ensureBucket(this.kycBucket, false);
  }

  private async ensureBucket(bucketName: string, isPublic: boolean) {
    try {
      const { data } = await this.client.storage.getBucket(bucketName);
      if (!data) {
        const { error } = await this.client.storage.createBucket(bucketName, {
          public: isPublic,
        });
        if (error && !/already exists/i.test(error.message)) {
          this.logger.warn(`No se pudo crear el bucket '${bucketName}': ${error.message}`);
        } else {
          this.logger.log(`Bucket '${bucketName}' configurado (public=${isPublic})`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Error al verificar/crear bucket '${bucketName}': ${err.message}`);
    }
  }

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
      const path = `${userId || 'general'}/${safeFilename}`;
      const storage = this.client.storage.from(this.kycBucket);

      const { error: uploadError } = await storage.upload(path, file.buffer, {
        contentType: detected.mime,
        upsert: false,
      });

      if (uploadError) {
        this.logger.error(`Error subiendo documento KYC a storage privado: ${uploadError.message}`);
        throw new BadRequestException(`No se pudo almacenar el documento KYC: ${uploadError.message}`);
      }

      const { data: signedData, error: signedError } = await storage.createSignedUrl(path, 24 * 60 * 60);
      if (signedError || !signedData?.signedUrl) {
        this.logger.error(`Error generando signed URL: ${signedError?.message}`);
        throw new BadRequestException('Documento guardado, pero falló la generación de la URL temporal');
      }

      return {
        url: signedData.signedUrl,
        path,
        purpose,
        mimeType: detected.mime,
        size: file.size,
        expiresIn: 86400,
      };
    }

    const path = `${purpose}/${safeFilename}`;
    const storage = this.client.storage.from(this.publicBucket);

    const { error: uploadError } = await storage.upload(path, file.buffer, {
      contentType: detected.mime,
      upsert: false,
    });

    if (uploadError) {
      this.logger.error(`Error subiendo archivo público: ${uploadError.message}`);
      throw new BadRequestException(`No se pudo subir el archivo: ${uploadError.message}`);
    }

    const { data } = storage.getPublicUrl(path);
    return {
      url: data.publicUrl,
      path,
      purpose,
      mimeType: detected.mime,
      size: file.size,
    };
  }

  async getPresignedKycUrl(path: string, expiresInSeconds = 86400): Promise<string> {
    const storage = this.client.storage.from(this.kycBucket);
    const { data, error } = await storage.createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`No se pudo generar la URL segura para el documento: ${error?.message}`);
    }
    return data.signedUrl;
  }

  /**
   * Refresca determinísticamente un enlace KYC firmado si ha expirado o proviene de Supabase Storage.
   * Si es IPFS (ipfs:// o hash CID), lo normaliza a gateway HTTPS para compatibilidad directa.
   */
  async getFreshSignedUrl(urlOrPath?: string | null): Promise<string | null> {
    if (!urlOrPath) return null;
    const trimmed = urlOrPath.trim();
    if (!trimmed) return null;

    // Normalizar IPFS
    if (trimmed.startsWith('ipfs://')) {
      const cid = trimmed.replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
      return `https://ipfs.io/ipfs/${cid}`;
    }
    if (/^Qm[1-9A-HJ-NP-za-km-z]{44}/.test(trimmed) || /^bafy[a-z0-9]{55}/.test(trimmed)) {
      return `https://ipfs.io/ipfs/${trimmed}`;
    }

    // Si es del bucket privado KYC o contiene /object/sign/
    if (trimmed.includes(this.kycBucket) || trimmed.includes('/object/sign/')) {
      try {
        let storagePath = trimmed;
        if (trimmed.includes(`/${this.kycBucket}/`)) {
          const parts = trimmed.split(`/${this.kycBucket}/`)[1];
          if (parts) {
            storagePath = parts.split('?')[0];
          }
        }
        const storage = this.client.storage.from(this.kycBucket);
        const { data, error } = await storage.createSignedUrl(storagePath, 24 * 60 * 60);
        if (!error && data?.signedUrl) {
          return data.signedUrl;
        }
      } catch (e: any) {
        this.logger.warn(`Error refrescando signed URL para KYC: ${e.message}`);
      }
    }

    return trimmed;
  }

  /**
   * Obtiene el flujo binario (Stream/Buffer) y metadatos de un archivo almacenado
   * ya sea en el bucket privado de KYC o en el público, garantizando descarga controlada.
   */
  async getFileStream(pathOrUrl: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    size: number;
  }> {
    if (!pathOrUrl || !pathOrUrl.trim()) {
      throw new BadRequestException('Ruta o identificador de archivo no proporcionado');
    }

    let cleanPath = pathOrUrl.trim();
    let targetBucket = this.kycBucket;

    // Detectar si la ruta especifica el bucket o viene como URL completa
    if (cleanPath.includes(`/${this.publicBucket}/`)) {
      targetBucket = this.publicBucket;
      cleanPath = cleanPath.split(`/${this.publicBucket}/`)[1].split('?')[0];
    } else if (cleanPath.includes(`/${this.kycBucket}/`)) {
      targetBucket = this.kycBucket;
      cleanPath = cleanPath.split(`/${this.kycBucket}/`)[1].split('?')[0];
    } else if (cleanPath.startsWith('collection/') || cleanPath.startsWith('receipt/')) {
      targetBucket = this.publicBucket;
    }

    cleanPath = decodeURIComponent(cleanPath.split('?')[0]);

    const storage = this.client.storage.from(targetBucket);
    const { data, error } = await storage.download(cleanPath);

    if (error || !data) {
      // Intento en el otro bucket en caso de que esté cruzado
      const alternateBucket = targetBucket === this.kycBucket ? this.publicBucket : this.kycBucket;
      const altStorage = this.client.storage.from(alternateBucket);
      const { data: altData, error: altError } = await altStorage.download(cleanPath);

      if (altError || !altData) {
        this.logger.error(`Error descargando archivo de storage '${cleanPath}': ${error?.message || altError?.message}`);
        throw new BadRequestException('El archivo solicitado no existe o no se encuentra disponible');
      }

      const arrayBuffer = await altData.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const detected = validateMagicBytes(buffer);
      const mimeType = detected?.mime || altData.type || 'application/octet-stream';

      return {
        buffer,
        mimeType,
        size: buffer.length,
      };
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const detected = validateMagicBytes(buffer);
    const mimeType = detected?.mime || data.type || 'application/octet-stream';

    return {
      buffer,
      mimeType,
      size: buffer.length,
    };
  }
}

