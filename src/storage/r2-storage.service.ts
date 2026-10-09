import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  IStorageProvider,
  StorageUploadOptions,
  StorageUploadResult,
} from './storage.interface';

@Injectable()
export class R2StorageService implements IStorageProvider {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;
  private readonly publicBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const accountId =
      this.configService.get<string>('CLOUDFLARE_R2_ACCOUNT_ID') ||
      '217e497eb88c67e9097f7c06216d9a5b';
    const accessKeyId =
      this.configService.get<string>('CLOUDFLARE_R2_ACCESS_KEY_ID') || '';
    const secretAccessKey =
      this.configService.get<string>('CLOUDFLARE_R2_SECRET_ACCESS_KEY') || '';

    this.bucketName =
      this.configService.get<string>('CLOUDFLARE_R2_BUCKET_NAME') ||
      'livora-storage';

    const customPublic = this.configService.get<string>(
      'CLOUDFLARE_R2_PUBLIC_URL',
    );
    this.publicBaseUrl = customPublic
      ? customPublic.replace(/\/+$/, '')
      : 'https://media.grupolivoralabs.com';

    const endpoint =
      this.configService.get<string>('CLOUDFLARE_R2_ENDPOINT') ||
      `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.logger.log(
      `R2StorageService inicializado para bucket '${this.bucketName}' en endpoint: ${endpoint}`,
    );
  }

  getPublicUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${this.publicBaseUrl}/${cleanPath}`;
  }

  async upload(
    path: string,
    buffer: Buffer,
    options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const isPublic = options.isPublic ?? true;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: cleanPath,
        Body: buffer,
        ContentType: options.contentType,
      });

      await this.s3Client.send(command);

      let url: string;
      let expiresIn: number | undefined;

      if (isPublic) {
        url = this.getPublicUrl(cleanPath);
      } else {
        // Generar URL prefirmada temporal para archivos privados (KYC)
        expiresIn = 900; // 15 minutos estándar de seguridad
        url = await this.getSignedUrl(cleanPath, expiresIn);
      }

      return {
        url,
        path: cleanPath,
        size: buffer.length,
        mimeType: options.contentType,
        isPublic,
        expiresIn,
      };
    } catch (err: any) {
      this.logger.error(
        `Error al subir objeto a Cloudflare R2 ('${cleanPath}'): ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async getSignedUrl(path: string, expiresInSeconds = 900): Promise<string> {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: cleanPath,
      });
      return await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresInSeconds,
      });
    } catch (err: any) {
      this.logger.error(
        `Error al generar URL prefirmada R2 ('${cleanPath}'): ${err.message}`,
      );
      throw err;
    }
  }

  async delete(path: string): Promise<void> {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: cleanPath,
      });
      await this.s3Client.send(command);
    } catch (err: any) {
      this.logger.warn(
        `No se pudo eliminar el objeto de R2 ('${cleanPath}'): ${err.message}`,
      );
    }
  }

  async getFile(path: string): Promise<{ buffer: Buffer; mimeType: string; size: number }> {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: cleanPath,
      });
      const response = await this.s3Client.send(command);
      const byteArray = await response.Body?.transformToByteArray();
      const buffer = Buffer.from(byteArray || []);
      return {
        buffer,
        mimeType: response.ContentType || 'application/octet-stream',
        size: response.ContentLength || buffer.length,
      };
    } catch (err: any) {
      this.logger.error(
        `Error al obtener objeto de Cloudflare R2 ('${cleanPath}'): ${err.message}`,
      );
      throw err;
    }
  }
}
