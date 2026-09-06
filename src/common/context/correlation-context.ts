import { AsyncLocalStorage } from 'async_hooks';
import * as crypto from 'crypto';

export class CorrelationContext {
  private static readonly storage = new AsyncLocalStorage<string>();

  static run<T>(correlationId: string, callback: () => T): T {
    return this.storage.run(correlationId, callback);
  }

  static getCorrelationId(): string {
    return this.storage.getStore() || crypto.randomUUID();
  }

  static getStore(): string | undefined {
    return this.storage.getStore();
  }
}
