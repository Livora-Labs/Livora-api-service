import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KDF_SALT = 'livora_wallet_encryption_salt_kdf_v1';
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;

export class CryptoUtil {
  /**
   * Deriva una clave AES-256 de 32 bytes usando PBKDF2 con SHA-512 (estándar NIST).
   */
  private static deriveKeyPbkdf2(secretKey: string): Buffer {
    return crypto.pbkdf2Sync(
      String(secretKey),
      KDF_SALT,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      'sha512',
    );
  }

  /**
   * Derivación legacy con SHA-256 simple para retrocompatibilidad con registros existentes.
   */
  private static deriveKeyLegacySha256(secretKey: string): Buffer {
    return crypto.createHash('sha256').update(String(secretKey)).digest();
  }

  /**
   * Encrypts a plain text string (e.g. private key) using AES-256-GCM and PBKDF2 key derivation.
   * @param text Plain text to encrypt
   * @param secretKey Master encryption secret
   * @returns Formatted hex string: iv:authTag:encryptedData
   */
  static encrypt(text: string, secretKey: string): string {
    const key = this.deriveKeyPbkdf2(secretKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts a cipher text formatted as iv:authTag:encryptedData.
   * Attempts decryption with PBKDF2 first; if authentication tag fails, falls back to legacy SHA-256.
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
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    // 1. Intentar descifrar con la clave estándar PBKDF2
    try {
      const key = this.deriveKeyPbkdf2(secretKey);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (pbkdf2Error) {
      // 2. Fallback a clave legacy SHA-256 para billeteras previamente cifradas
      try {
        const legacyKey = this.deriveKeyLegacySha256(secretKey);
        const legacyDecipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv);
        legacyDecipher.setAuthTag(authTag);

        let legacyDecrypted = legacyDecipher.update(encryptedText, 'hex', 'utf8');
        legacyDecrypted += legacyDecipher.final('utf8');
        return legacyDecrypted;
      } catch {
        throw new Error('No se pudo descifrar la información o la firma AuthTag no es válida');
      }
    }
  }
}
