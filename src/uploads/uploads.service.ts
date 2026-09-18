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

      const { data: signedData, error: signedError } = await storage.createSignedUrl(path, 15 * 60);
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
        expiresIn: 900,
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

  async getPresignedKycUrl(path: string, expiresInSeconds = 900): Promise<string> {
    const storage = this.client.storage.from(this.kycBucket);
    const { data, error } = await storage.createSignedUrl(path, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`No se pudo generar la URL segura para el documento: ${error?.message}`);
    }
    return data.signedUrl;
  }
}
