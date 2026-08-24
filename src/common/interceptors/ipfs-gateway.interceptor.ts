import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class IpfsGatewayInterceptor implements NestInterceptor {
  private gatewayUrl: string;

  constructor(private readonly configService: ConfigService) {
    const gateway =
      this.configService.get<string>('IPFS_GATEWAY_URL') ||
      'https://ipfs.io/ipfs/';
    this.gatewayUrl = gateway.endsWith('/') ? gateway : `${gateway}/`;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.formatResponse(data)));
  }

  private formatResponse(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }

    // Preservar objetos no-planos (Date, Buffer, etc.). Sin esto, al recorrer un
    // Date con Object.entries() se reconstruye como {} y las fechas se pierden.
    if (data instanceof Date || Buffer.isBuffer(data)) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.formatResponse(item));
    }

    if (typeof data === 'object') {
      // Si el objeto es una clase (como DTO o entidad Prisma) y tiene propiedades
      const formatted: any = {};
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && this.shouldFormatField(key, value)) {
          formatted[key] = this.formatIpfsUrl(value);
        } else {
          formatted[key] = this.formatResponse(value);
        }
      }
      return formatted;
    }

    return data;
  }

  private shouldFormatField(key: string, value: string): boolean {
    const ipfsKeys = ['ipfsCid', 'ipfsHash', 'photoUrl'];

    // Si la llave está en nuestra lista de llaves de IPFS
    if (ipfsKeys.includes(key)) {
      return true;
    }

    // O si el valor tiene protocolo ipfs:// o parece un hash IPFS (CID v0 o v1)
    if (value.startsWith('ipfs://')) {
      return true;
    }

    // Hash CID v0 (inicia con Qm y tiene 46 caracteres)
    const isCidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value);
    if (isCidV0) {
      return true;
    }

    // Hash CID v1 (inicia con bafy y tiene 59 caracteres)
    const isCidV1 = /^bafy[a-z0-9]{55}$/.test(value);
    if (isCidV1) {
      return true;
    }

    return false;
  }

  private formatIpfsUrl(value: string): string {
    if (!value) return value;

    // Si ya empieza con http:// o https://
    if (value.startsWith('http://') || value.startsWith('https://')) {
      // Si es un enlace de ipfs redundante, lo re-formateamos al gateway dedicado
      if (value.includes('/ipfs/')) {
        const parts = value.split('/ipfs/');
        const cid = parts[parts.length - 1];
        return `${this.gatewayUrl}${cid}`;
      }
      return value;
    }

    // Limpiar prefijo ipfs:// si existe
    let cleanVal = value.replace(/^ipfs:\/\//, '');
    if (cleanVal.startsWith('ipfs/')) {
      cleanVal = cleanVal.substring(5);
    }

    return `${this.gatewayUrl}${cleanVal}`;
  }
}
