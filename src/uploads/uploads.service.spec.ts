import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from './uploads.service';
import { validateMagicBytes } from './utils/magic-bytes.util';

describe('UploadsService & MagicBytes (Binary Inspection & Private KYC)', () => {
  describe('validateMagicBytes', () => {
    it('should detect valid PNG header (89 50 4E 47)', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = validateMagicBytes(pngBuffer);
      expect(res).toEqual({ mime: 'image/png', extension: 'png' });
    });

    it('should detect valid JPEG header (FF D8 FF)', () => {
      const jpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const res = validateMagicBytes(jpgBuffer);
      expect(res).toEqual({ mime: 'image/jpeg', extension: 'jpg' });
    });

    it('should detect valid PDF header (25 50 44 46 / %PDF)', () => {
      const pdfBuffer = Buffer.from('%PDF-1.7 header content here');
      const res = validateMagicBytes(pdfBuffer);
      expect(res).toEqual({ mime: 'application/pdf', extension: 'pdf' });
    });

    it('should reject spoofed or unknown binary files (e.g. bash scripts or text)', () => {
      const scriptBuffer = Buffer.from('#!/bin/bash\necho "exploit"');
      expect(validateMagicBytes(scriptBuffer)).toBeNull();

      const emptyBuffer = Buffer.alloc(2);
      expect(validateMagicBytes(emptyBuffer)).toBeNull();
    });
  });

  describe('UploadsService functionality', () => {
    let service: UploadsService;
    let mockStorage: any;
    let mockClient: any;

    beforeEach(() => {
      mockStorage = {
        upload: jest.fn().mockResolvedValue({ error: null }),
        getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://storage.livora.pe/public/file.png' } }),
        createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.livora.pe/signed/kyc.pdf?token=123' }, error: null }),
        getBucket: jest.fn().mockResolvedValue({ data: { name: 'bucket' } }),
        createBucket: jest.fn().mockResolvedValue({ error: null }),
      };

      mockClient = {
        storage: {
          from: jest.fn().mockReturnValue(mockStorage),
          getBucket: mockStorage.getBucket,
          createBucket: mockStorage.createBucket,
        },
      };

      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'SUPABASE_URL') return 'https://test.supabase.co';
          if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'test-service-key';
          return null;
        }),
      } as unknown as ConfigService;

      service = new UploadsService(configService);
      (service as any).client = mockClient;
    });

    it('should reject file upload when magic bytes do not match allowed formats', async () => {
      const fakeFile: any = {
        buffer: Buffer.from('plain text content pretending to be image'),
        mimetype: 'image/jpeg',
        size: 50,
      };

      await expect(service.upload(fakeFile, 'collection')).rejects.toThrow(BadRequestException);
    });

    it('should reject PDF uploads for non-KYC purposes', async () => {
      const pdfFile: any = {
        buffer: Buffer.from('%PDF-1.4 sample content'),
        mimetype: 'application/pdf',
        size: 500,
      };

      await expect(service.upload(pdfFile, 'collection')).rejects.toThrow(
        'Los archivos PDF solo están permitidos para el propósito KYC.',
      );
    });

    it('should upload KYC document to private bucket and return 15-minute presigned URL', async () => {
      const pdfFile: any = {
        buffer: Buffer.from('%PDF-1.4 sample content'),
        mimetype: 'application/pdf',
        size: 500,
      };

      const result = await service.upload(pdfFile, 'kyc', 'user-uuid-123');

      expect(mockClient.storage.from).toHaveBeenCalledWith('livora-kyc-private');
      expect(mockStorage.upload).toHaveBeenCalled();
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith(expect.stringContaining('user-uuid-123/'), 900);
      expect(result.expiresIn).toBe(900);
      expect(result.url).toContain('https://storage.livora.pe/signed/kyc.pdf');
    });

    it('should generate presigned KYC URL with custom or default expiration', async () => {
      const url = await service.getPresignedKycUrl('user-123/doc.pdf', 900);
      expect(mockClient.storage.from).toHaveBeenCalledWith('livora-kyc-private');
      expect(mockStorage.createSignedUrl).toHaveBeenCalledWith('user-123/doc.pdf', 900);
      expect(url).toBe('https://storage.livora.pe/signed/kyc.pdf?token=123');
    });
  });
});
