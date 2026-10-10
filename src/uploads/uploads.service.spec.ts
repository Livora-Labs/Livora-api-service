import { BadRequestException } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { R2StorageService } from '../storage/r2-storage.service';
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

  describe('UploadsService functionality with Cloudflare R2', () => {
    let service: UploadsService;
    let mockStorageService: jest.Mocked<Partial<R2StorageService>>;

    beforeEach(() => {
      mockStorageService = {
        upload: jest.fn().mockResolvedValue({
          url: 'https://media.grupolivoralabs.com/collection/file.png',
          path: 'collection/file.png',
          expiresIn: undefined,
        }),
        getSignedUrl: jest.fn().mockResolvedValue('https://media.grupolivoralabs.com/signed/kyc.pdf?token=123'),
        delete: jest.fn().mockResolvedValue(undefined),
      };

      service = new UploadsService(mockStorageService as R2StorageService);
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

    it('should upload KYC document to private path and return presigned URL', async () => {
      mockStorageService.upload = jest.fn().mockResolvedValue({
        url: 'https://media.grupolivoralabs.com/signed/kyc.pdf?token=123',
        path: 'kyc/user-uuid-123/file.pdf',
        expiresIn: 900,
      });

      const pdfFile: any = {
        buffer: Buffer.from('%PDF-1.4 sample content'),
        mimetype: 'application/pdf',
        size: 500,
      };

      const result = await service.upload(pdfFile, 'kyc', 'user-uuid-123');

      expect(mockStorageService.upload).toHaveBeenCalledWith(
        expect.stringContaining('kyc/user-uuid-123/'),
        pdfFile.buffer,
        { contentType: 'application/pdf', isPublic: false },
      );
      expect(result.expiresIn).toBe(900);
      expect(result.url).toContain('https://media.grupolivoralabs.com/signed/kyc.pdf');
    });

    it('should generate presigned KYC URL with custom or default expiration', async () => {
      const url = await service.getPresignedKycUrl('user-123/doc.pdf', 900);
      expect(mockStorageService.getSignedUrl).toHaveBeenCalledWith('user-123/doc.pdf', 900);
      expect(url).toBe('https://media.grupolivoralabs.com/signed/kyc.pdf?token=123');
    });
  });
});
