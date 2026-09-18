import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  context: string;
  message: string;
  correlationId?: string;
  data?: any;
}

export interface AuditLogQueryParams {
  level?: string;
  correlationId?: string;
  search?: string;
  limit?: number;
  skip?: number;
}

@Injectable()
export class AuditLogBufferService {
  private readonly maxBufferSize = 1000;
  private readonly buffer: AuditLogEntry[] = [];

  constructor() {
    // Registro inicial del arranque del servicio de auditoría
    this.add({
      level: 'INFO',
      context: 'AuditLogBufferService',
      message: 'Sistema de buffer circular de auditoría operativa inicializado exitosamente (Capacidad: 1,000 registros)',
    });
  }

  /**
   * Sanitiza objetos para evitar la fuga accidental de secretos, contraseñas o claves privadas en logs.
   */
  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') return data;
    try {
      const copy = JSON.parse(JSON.stringify(data));
      const redactKeys = [
        'password',
        'token',
        'authorization',
        'secret',
        'privatekey',
        'encryptedprivatekey',
        'encryptioniv',
        'encryptiontag',
        'receptionpin',
        'pin',
      ];

      const sanitizeRecursive = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          const lower = key.toLowerCase();
          if (redactKeys.some((k) => lower.includes(k))) {
            obj[key] = '[REDACTADO_POR_SEGURIDAD]';
          } else if (typeof obj[key] === 'object') {
            sanitizeRecursive(obj[key]);
          }
        }
      };

      sanitizeRecursive(copy);
      return copy;
    } catch {
      return '[OBJETO_NO_SERIALIZABLE]';
    }
  }

  /**
   * Agrega un nuevo evento al buffer circular de auditoría.
   */
  add(entry: {
    level: 'INFO' | 'WARN' | 'ERROR';
    context: string;
    message: string;
    correlationId?: string;
    data?: any;
  }) {
    const record: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: entry.level,
      context: entry.context,
      message: entry.message,
      correlationId: entry.correlationId,
      data: entry.data ? this.sanitizeData(entry.data) : undefined,
    };

    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift(); // Elimina el más antiguo para mantener tamaño constante O(1)
    }
    this.buffer.push(record);
  }

  /**
   * Consulta filtrada del buffer para soporte técnico y operaciones.
   */
  query(params: AuditLogQueryParams = {}) {
    const limit = Math.min(params.limit ? Number(params.limit) : 50, 200);
    const skip = params.skip ? Number(params.skip) : 0;

    let filtered = [...this.buffer].reverse(); // Más recientes primero

    if (params.level && params.level !== 'ALL') {
      const targetLevel = params.level.toUpperCase();
      filtered = filtered.filter((log) => log.level === targetLevel);
    }

    if (params.correlationId && params.correlationId.trim()) {
      const cid = params.correlationId.trim().toLowerCase();
      filtered = filtered.filter(
        (log) => log.correlationId && log.correlationId.toLowerCase().includes(cid),
      );
    }

    if (params.search && params.search.trim()) {
      const term = params.search.trim().toLowerCase();
      filtered = filtered.filter(
        (log) =>
          log.message.toLowerCase().includes(term) ||
          log.context.toLowerCase().includes(term) ||
          (log.correlationId && log.correlationId.toLowerCase().includes(term)),
      );
    }

    const total = filtered.length;
    const items = filtered.slice(skip, skip + limit);

    return {
      total,
      limit,
      skip,
      items,
      stats: {
        totalBuffered: this.buffer.length,
        errors: this.buffer.filter((l) => l.level === 'ERROR').length,
        warnings: this.buffer.filter((l) => l.level === 'WARN').length,
        info: this.buffer.filter((l) => l.level === 'INFO').length,
      },
    };
  }
}
