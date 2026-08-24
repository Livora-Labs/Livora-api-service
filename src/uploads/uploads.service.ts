import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const BUCKET = 'livora-uploads';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
const PURPOSES = ['collection', 'kyc', 'receipt'];

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);
  // Cliente DEDICADO con la service key. No se reutiliza el cliente compartido
  // de auth porque su sesión se contamina con signInWithPassword/getUser y el
  // header de Authorization deja de ser el service_role → Storage devuelve RLS.
  private readonly client: SupabaseClient;

  constructor(private readonly configService: ConfigService) {
    this.client = createClient(
      this.configService.get<string>('SUPABASE_URL') || '',
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  async onModuleInit() {
    // Crear el bucket público si no existe (idempotente).
    try {
      const { data } = await this.client.storage.getBucket(BUCKET);
      if (!data) {
        const { error } = await this.client.storage.createBucket(BUCKET, {
          public: true,
        });
        if (error && !/already exists/i.test(error.message)) {
          this.logger.warn(`No se pudo crear el bucket '${BUCKET}': ${error.message}`);
        } else {
          this.logger.log(`Bucket '${BUCKET}' listo (público)`);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `No se pudo verificar/crear el bucket '${BUCKET}': ${err.message}`,
      );
    }
  }

  async upload(file: Express.Multer.File, purposeRaw?: string) {
    if (!file) {
      throw new BadRequestException(
        'No se recibió ningún archivo en el campo "file"',
      );
    }

    const purpose = PURPOSES.includes(purposeRaw || '')
      ? (purposeRaw as string)
      : 'collection';

    if (file.size > MAX_BYTES) {
      throw new BadRequestException('El archivo supera el máximo de 10 MB');
    }

    const allowed = [...IMAGE_TYPES];
    if (purpose === 'kyc') {
      allowed.push('application/pdf');
    }
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException(
        `Tipo de archivo no permitido (${file.mimetype}). Permitidos para '${purpose}': ${allowed.join(', ')}`,
      );
    }

    const ext = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : file.mimetype.split('/').pop();
    const path = `${purpose}/${randomUUID()}.${ext}`;

    const storage = this.client.storage.from(BUCKET);
    const { error } = await storage.upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
    if (error) {
      this.logger.error(`Error subiendo a Supabase Storage: ${error.message}`);
      throw new BadRequestException(
        `No se pudo subir el archivo: ${error.message}`,
      );
    }

    const { data } = storage.getPublicUrl(path);
    return {
      url: data.publicUrl,
      purpose,
      mimeType: file.mimetype,
      size: file.size,
    };
  }
}
