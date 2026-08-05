import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DUMMY_IPFS_HASH } from '../blockchain.constants';

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Sube los metadatos JSON del lote a Pinata (IPFS).
   * @param payload Objeto manifest con información del lote
   * @returns ipfs_cid (string de 46 caracteres) o fallback en desarrollo/error
   */
  async uploadBatchMetadata(payload: any): Promise<string> {
    const apiKey = this.configService.get<string>('PINATA_API_KEY');
    const secretKey = this.configService.get<string>('PINATA_SECRET_KEY');

    if (!apiKey || !secretKey || apiKey === 'value' || secretKey === 'value') {
      this.logger.warn(
        'Credenciales de Pinata no configuradas o en valor por defecto. Usando IPFS CID simulado (fallback).',
      );
      return DUMMY_IPFS_HASH;
    }

    try {
      this.logger.log(`Subiendo metadatos a Pinata IPFS para batchId: ${payload?.batchId}`);

      const body = {
        pinataContent: payload,
        pinataMetadata: {
          name: `batch-${payload?.batchId || Date.now()}`,
        },
      };

      const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          pinata_api_key: apiKey,
          pinata_secret_api_key: secretKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinata API error [${response.status}]: ${errorText}`);
      }

      const data = (await response.json()) as { IpfsHash?: string };

      if (data && data.IpfsHash) {
        this.logger.log(`Metadatos subidos exitosamente a IPFS. CID: ${data.IpfsHash}`);
        return data.IpfsHash;
      }

      throw new Error('Respuesta de Pinata no contiene IpfsHash');
    } catch (error: any) {
      this.logger.error(
        `Error al subir metadatos a Pinata IPFS: ${error.message}. Aplicando fallback CID.`,
        error.stack,
      );
      return DUMMY_IPFS_HASH;
    }
  }
}
