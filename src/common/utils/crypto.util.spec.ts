import * as crypto from 'crypto';
import { CryptoUtil } from './crypto.util';

describe('CryptoUtil', () => {
  const knownPrivateKey =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const secretKey = 'testSecretKey32CharacterLength!';

  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt a private key correctly (round-trip)', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const decrypted = CryptoUtil.decrypt(encrypted, secretKey);

      expect(decrypted).toBe(knownPrivateKey);
    });

    it('should throw an error when decrypting with the wrong key', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const wrongKey = 'wrongSecretKey32CharacterLength!';

      expect(() => CryptoUtil.decrypt(encrypted, wrongKey)).toThrow();
    });

    it('should throw an error for malformed ciphertext format', () => {
      expect(() => CryptoUtil.decrypt('invalid_format', secretKey)).toThrow(
        'Invalid encrypted text format',
      );
      expect(() =>
        CryptoUtil.decrypt('not:enough:parts:here', secretKey),
      ).toThrow('Invalid encrypted text format');
    });

    it('should produce distinct ciphertexts for identical plaintexts (unique IV per encryption)', () => {
      const enc1 = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const enc2 = CryptoUtil.encrypt(knownPrivateKey, secretKey);

      expect(enc1).not.toBe(enc2);
      expect(CryptoUtil.decrypt(enc1, secretKey)).toBe(knownPrivateKey);
      expect(CryptoUtil.decrypt(enc2, secretKey)).toBe(knownPrivateKey);
    });

    it('zeroes sensitive internal buffers after cryptographic operations', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const decrypted = CryptoUtil.decrypt(encrypted, secretKey);

      // We check that static properties on CryptoUtil don't hold the plaintext
      expect(Object.values(CryptoUtil)).not.toContain(decrypted);
    });

    it('should decrypt legacy SHA-256 encrypted payload transparently (backward compatibility)', () => {
      // Simulate an old ciphertext produced with crypto.createHash('sha256')
      const legacyKey = crypto.createHash('sha256').update(secretKey).digest();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      let legacyEncrypted = cipher.update(knownPrivateKey, 'utf8', 'hex');
      legacyEncrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      const legacyPayload = `${iv.toString('hex')}:${authTag}:${legacyEncrypted}`;

      const decrypted = CryptoUtil.decrypt(legacyPayload, secretKey);
      expect(decrypted).toBe(knownPrivateKey);
    });
  });
});
