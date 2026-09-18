export interface DetectedFileType {
  mime: 'image/jpeg' | 'image/png' | 'application/pdf';
  extension: 'jpg' | 'png' | 'pdf';
}

export function validateMagicBytes(buffer: Buffer): DetectedFileType | null {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // PNG: 89 50 4E 47 (\x89PNG)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mime: 'image/png', extension: 'png' };
  }

  // JPEG / JPG: FF D8 FF
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }

  // PDF: 25 50 44 46 (%PDF)
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return { mime: 'application/pdf', extension: 'pdf' };
  }

  return null;
}
