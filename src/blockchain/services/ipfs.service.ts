import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DUMMY_IPFS_HASH } from '../blockchain.constants';

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Sube cualquier objeto JSON a Pinata (IPFS).
   * @param payload Contenido JSON a subir
   * @param name Nombre identificador para metadatos de Pinata
   * @returns ipfs_cid (string de 46 caracteres) o fallback
   */
  async uploadJson(payload: any, name: string): Promise<string> {
    const apiKey = this.configService.get<string>('PINATA_API_KEY');
    const secretKey = this.configService.get<string>('PINATA_SECRET_KEY');

    if (!apiKey || !secretKey || apiKey === 'value' || secretKey === 'value') {
      this.logger.warn(
        'Credenciales de Pinata no configuradas o en valor por defecto. Usando IPFS CID simulado (fallback).',
      );
      return DUMMY_IPFS_HASH;
    }

    try {
      this.logger.log(`Subiendo JSON a Pinata IPFS (${name})...`);

      const body = {
        pinataContent: payload,
        pinataMetadata: {
          name,
        },
      };

      const response = await fetch(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            pinata_api_key: apiKey,
            pinata_secret_api_key: secretKey,
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinata API error [${response.status}]: ${errorText}`);
      }

      const data = (await response.json()) as { IpfsHash?: string };

      if (data && data.IpfsHash) {
        this.logger.log(
          `JSON subido exitosamente a IPFS. CID: ${data.IpfsHash}`,
        );
        return data.IpfsHash;
      }

      throw new Error('Respuesta de Pinata no contiene IpfsHash');
    } catch (error: any) {
      this.logger.error(
        `Error al subir JSON a Pinata IPFS: ${error.message}. Aplicando fallback CID.`,
        error.stack,
      );
      return DUMMY_IPFS_HASH;
    }
  }

  /**
   * Sube los metadatos JSON del lote a Pinata (IPFS).
   * @param payload Objeto manifest con información del lote
   * @returns ipfs_cid (string de 46 caracteres) o fallback en desarrollo/error
   */
  async uploadBatchMetadata(payload: any): Promise<string> {
    return this.uploadJson(payload, `batch-${payload?.batchId || Date.now()}`);
  }

  /**
   * Sube un archivo binario (como una foto) a Pinata (IPFS) utilizando pinFileToIPFS.
   * @param file Archivo recibido en la petición Express/Multer
   * @returns ipfs_cid (string de 46 caracteres) o fallback en desarrollo/error
   */
  async uploadFile(file: Express.Multer.File): Promise<string> {
    const apiKey = this.configService.get<string>('PINATA_API_KEY');
    const secretKey = this.configService.get<string>('PINATA_SECRET_KEY');

    if (!apiKey || !secretKey || apiKey === 'value' || secretKey === 'value') {
      this.logger.warn(
        'Credenciales de Pinata no configuradas o en valor por defecto. Usando fallback de CID para archivo.',
      );
      return DUMMY_IPFS_HASH;
    }

    try {
      this.logger.log(`Subiendo archivo a Pinata IPFS: ${file.originalname}`);

      const formData = new FormData();
      const blob = new Blob([file.buffer as any], { type: file.mimetype });
      formData.append('file', blob, file.originalname);

      const pinataMetadata = JSON.stringify({
        name: `file-${Date.now()}-${file.originalname}`,
      });
      formData.append('pinataMetadata', pinataMetadata);

      const response = await fetch(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        {
          method: 'POST',
          headers: {
            pinata_api_key: apiKey,
            pinata_secret_api_key: secretKey,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinata API error [${response.status}]: ${errorText}`);
      }

      const data = (await response.json()) as { IpfsHash?: string };

      if (data && data.IpfsHash) {
        this.logger.log(
          `Archivo subido exitosamente a IPFS. CID: ${data.IpfsHash}`,
        );
        return data.IpfsHash;
      }

      throw new Error('Respuesta de Pinata no contiene IpfsHash');
    } catch (error: any) {
      this.logger.error(
        `Error al subir archivo a Pinata IPFS: ${error.message}. Aplicando fallback CID.`,
        error.stack,
      );
      return DUMMY_IPFS_HASH;
    }
  }

  /**
   * Concatenación del IPFS_GATEWAY_URL con la CID o path de IPFS.
   * Si ya es una URL HTTP/HTTPS externa (no-IPFS), la devuelve tal cual.
   */
  getGatewayUrl(cidOrPath: string): string {
    if (!cidOrPath) return '';

    const gateway =
      this.configService.get<string>('IPFS_GATEWAY_URL') ||
      'https://ipfs.io/ipfs/';
    const cleanGateway = gateway.endsWith('/') ? gateway : `${gateway}/`;

    // Si ya empieza con http:// o https://
    if (cidOrPath.startsWith('http://') || cidOrPath.startsWith('https://')) {
      // Si contiene ipfs, podemos reformatearlo con el gateway dedicado
      if (cidOrPath.includes('/ipfs/')) {
        const parts = cidOrPath.split('/ipfs/');
        const cid = parts[parts.length - 1];
        return `${cleanGateway}${cid}`;
      }
      return cidOrPath;
    }

    // Limpiar prefijo "ipfs://"
    let cleanCid = cidOrPath.replace(/^ipfs:\/\//, '');
    if (cleanCid.startsWith('ipfs/')) {
      cleanCid = cleanCid.substring(5);
    }

    return `${cleanGateway}${cleanCid}`;
  }
}
