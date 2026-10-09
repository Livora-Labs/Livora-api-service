export interface StorageUploadOptions {
  contentType: string;
  isPublic?: boolean;
}

export interface StorageUploadResult {
  url: string;
  path: string;
  size: number;
  mimeType: string;
  isPublic: boolean;
  expiresIn?: number;
}

export interface IStorageProvider {
  upload(path: string, buffer: Buffer, options: StorageUploadOptions): Promise<StorageUploadResult>;
  getSignedUrl(path: string, expiresInSeconds?: number): Promise<string>;
  delete(path: string): Promise<void>;
  getPublicUrl(path: string): string;
  getFile(path: string): Promise<{ buffer: Buffer; mimeType: string; size: number }>;
}
