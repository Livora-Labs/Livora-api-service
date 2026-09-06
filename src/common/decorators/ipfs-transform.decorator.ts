import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { IpfsGatewayInterceptor } from '../interceptors/ipfs-gateway.interceptor';

/**
 * Decorador de ámbito para transformar CIDs y URLs relativas de IPFS
 * a URLs absolutas del gateway dedicado configurado.
 * Aplica el `IpfsGatewayInterceptor` únicamente en el controlador o endpoint objetivo.
 */
export function IpfsTransform() {
  return applyDecorators(UseInterceptors(IpfsGatewayInterceptor));
}
