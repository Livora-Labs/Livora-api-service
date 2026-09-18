import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KDF_SALT_LEGACY = 'livora_wallet_encryption_salt_kdf_v1';
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;

export class CryptoUtil {
  /**
   * Derives an AES-256 key (32 bytes) from a secret and salt using PBKDF2-SHA512 (NIST standard).
   */
  private static deriveKeyPbkdf2(secretKey: string, salt: Buffer | string): Buffer {
    return crypto.pbkdf2Sync(
      String(secretKey),
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha512',
    );
  }

  /**
   * Legacy SHA-256 derivation for backward compatibility with initial records.
   */
  private static deriveKeyLegacySha256(secretKey: string): Buffer {
    return crypto.createHash('sha256').update(String(secretKey)).digest();
  }

  /**
   * Encrypts plaintext using AES-256-GCM with a unique 16-byte random salt and 12-byte IV per record.
   * Output format: ${saltHex}:${ivHex}:${authTagHex}:${encryptedHex} (4 colon-separated hex components)
   */
  static encrypt(text: string, secretKey: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveKeyPbkdf2(secretKey, salt);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    key.fill(0); // Zeroize derived key buffer immediately

    return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts ciphertext directly into a mutable Buffer.
   * Supports both 4-part (salted) and 3-part (legacy) formats.
   */
  static decryptToBuffer(encryptedFormat: string, secretKey: string): Buffer {
    const parts = encryptedFormat.split(':');
    if (parts.length !== 3 && parts.length !== 4) {
      throw new Error('Invalid encrypted text format');
    }

    if (parts.length === 4) {
      const [saltHex, ivHex, authTagHex, encryptedText] = parts;
      if (saltHex.length !== 32 || ivHex.length !== 24 || authTagHex.length !== 32) {
        throw new Error('Invalid encrypted text format');
      }

      const salt = Buffer.from(saltHex, 'hex');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const key = this.deriveKeyPbkdf2(secretKey, salt);

      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(encryptedText, 'hex')),
          decipher.final(),
        ]);
        return decrypted;
      } catch {
        throw new Error('No se pudo descifrar la información o la firma AuthTag no es válida');
      } finally {
        key.fill(0);
        salt.fill(0);
        iv.fill(0);
        authTag.fill(0);
      }
    }

    // Legacy 3-part format: iv:authTag:encryptedText
    const [ivHex, authTagHex, encryptedText] = parts;
    if (ivHex.length !== 24 || authTagHex.length !== 32) {
      throw new Error('Invalid encrypted text format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    // 1. Try legacy PBKDF2 with static salt
    try {
      const key = this.deriveKeyPbkdf2(secretKey, KDF_SALT_LEGACY);
      try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedText, 'hex')),
          decipher.final(),
        ]);
      } finally {
        key.fill(0);
      }
    } catch {
      // 2. Fallback to legacy SHA-256
      try {
        const legacyKey = this.deriveKeyLegacySha256(secretKey);
        try {
          const legacyDecipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv);
          legacyDecipher.setAuthTag(authTag);
          return Buffer.concat([
            legacyDecipher.update(Buffer.from(encryptedText, 'hex')),
            legacyDecipher.final(),
          ]);
        } finally {
          legacyKey.fill(0);
        }
      } catch {
        throw new Error('No se pudo descifrar la información o la firma AuthTag no es válida');
      }
    }
  }

  /**
   * Decrypts ciphertext and returns UTF-8 string (backward compatible wrapper).
   */
  static decrypt(encryptedFormat: string, secretKey: string): string {
    const buf = this.decryptToBuffer(encryptedFormat, secretKey);
    const result = buf.toString('utf8');
    buf.fill(0);
    return result;
  }

  /**
   * Scoped execution helper: decrypts to Buffer, executes callback,
   * and guarantees immediate zeroization in a finally block.
   */
  static async withDecryptedKey<T>(
    encryptedFormat: string,
    secretKey: string,
    action: (keyBuffer: Buffer) => Promise<T> | T,
  ): Promise<T> {
    const keyBuf = this.decryptToBuffer(encryptedFormat, secretKey);
    try {
      return await Promise.resolve(action(keyBuf));
    } finally {
      keyBuf.fill(0);
    }
  }
}
