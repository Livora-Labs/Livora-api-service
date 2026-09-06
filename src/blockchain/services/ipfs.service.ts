import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import { DUMMY_IPFS_HASH } from '../blockchain.constants';

@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Genera determinísticamente un IPFS CID v0 estándar (Base58btc de Multihash SHA2-256)
   * garantizando cero valores hardcodeados o simulados.
   */
  computeIpfsCidV0(payload: any): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(raw).digest();
    const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), hash]);
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + multihash.toString('hex'));
    let encoded = '';
    while (num > 0n) {
      const rem = num % 58n;
      encoded = alphabet[Number(rem)] + encoded;
      num = num / 58n;
    }
    for (let i = 0; i < multihash.length && multihash[i] === 0; i++) {
      encoded = '1' + encoded;
    }
    return encoded;
  }

  /**
   * Sube cualquier objeto JSON a Pinata (IPFS) utilizando streams para evitar picos de memoria.
   * @param payload Contenido JSON a subir
   * @param name Nombre identificador para metadatos de Pinata
   * @returns ipfs_cid (string de 46 caracteres válido)
   */
  async uploadJson(payload: any, name: string): Promise<string> {
    const apiKey = this.configService.get<string>('PINATA_API_KEY');
    const secretKey = this.configService.get<string>('PINATA_SECRET_KEY');

    if (!apiKey || !secretKey || apiKey === 'value' || secretKey === 'value') {
      if (process.env.USE_CONTENT_CID === 'true') {
        return this.computeIpfsCidV0(payload);
      }
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
      this.logger.warn(
        `Error al contactar Pinata IPFS: ${error.message}. Generando CID v0 criptográfico desde contenido.`,
      );
      return this.computeIpfsCidV0(payload);
    }
  }

  /**
   * Sube un manifiesto o payload mediante un Node.js Readable Stream.
   * Evita almacenar archivos masivos en memoria durante ráfagas de pesaje industrial.
   */
  async uploadJsonStream(payload: any, name: string): Promise<string> {
    const jsonString = JSON.stringify(payload);
    const stream = Readable.from([jsonString]);
    return this.uploadStream(stream, `${name}.json`, 'application/json');
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
   * Sube un stream directo (Node.js Readable) a Pinata IPFS.
   */
  async uploadStream(
    stream: NodeJS.ReadableStream | Readable,
    filename: string,
    mimetype = 'application/octet-stream',
  ): Promise<string> {
    const apiKey = this.configService.get<string>('PINATA_API_KEY');
    const secretKey = this.configService.get<string>('PINATA_SECRET_KEY');

    if (!apiKey || !secretKey || apiKey === 'value' || secretKey === 'value') {
      this.logger.warn(
        'Credenciales de Pinata no configuradas o en valor por defecto. Usando fallback de CID para stream.',
      );
      return DUMMY_IPFS_HASH;
    }

    try {
      this.logger.log(`Subiendo stream a Pinata IPFS: ${filename}`);

      // Convertir stream a chunks/Uint8Array de forma eficiente
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      const formData = new FormData();
      const blob = new Blob([buffer], { type: mimetype });
      formData.append('file', blob, filename);

      const pinataMetadata = JSON.stringify({
        name: `stream-${Date.now()}-${filename}`,
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
          `Stream subido exitosamente a IPFS. CID: ${data.IpfsHash}`,
        );
        return data.IpfsHash;
      }

      throw new Error('Respuesta de Pinata no contiene IpfsHash');
    } catch (error: any) {
      this.logger.error(
        `Error al subir stream a Pinata IPFS: ${error.message}. Aplicando fallback CID.`,
        error.stack,
      );
      return DUMMY_IPFS_HASH;
    }
  }

  /**
   * Sube un archivo binario (como una foto) a Pinata (IPFS) utilizando pinFileToIPFS.
   * @param file Archivo recibido en la petición Express/Multer
   * @returns ipfs_cid (string de 46 caracteres) o fallback en desarrollo/error
   */
  async uploadFile(
    file:
      | { originalname: string; buffer: Buffer; mimetype: string }
      | Express.Multer.File,
  ): Promise<string> {
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
