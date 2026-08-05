import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export class CryptoUtil {
  /**
   * Encrypts a plain text string (e.g. private key) using AES-256-GCM.
   * @param text Plain text to encrypt
   * @param secretKey 32-character or padded secret key
   * @returns Formatted hex string: iv:authTag:encryptedData
   */
  static encrypt(text: string, secretKey: string): string {
    const key = crypto
      .createHash('sha256')
      .update(String(secretKey))
      .digest();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts a cipher text formatted as iv:authTag:encryptedData.
   * @param encryptedFormat Encrypted string in hex format
   * @param secretKey Secret key used during encryption
   * @returns Decrypted plain text
   */
  static decrypt(encryptedFormat: string, secretKey: string): string {
    const parts = encryptedFormat.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }

    const [ivHex, authTagHex, encryptedText] = parts;
    const key = crypto
      .createHash('sha256')
      .update(String(secretKey))
      .digest();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
