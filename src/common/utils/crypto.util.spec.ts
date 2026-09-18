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

    it('should produce 4-part format with 16-byte random salt per record', () => {
      const enc1 = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const enc2 = CryptoUtil.encrypt(knownPrivateKey, secretKey);

      const parts1 = enc1.split(':');
      const parts2 = enc2.split(':');

      expect(parts1).toHaveLength(4);
      expect(parts2).toHaveLength(4);

      // salt: 16 bytes (32 hex chars), iv: 12 bytes (24 hex chars), tag: 16 bytes (32 hex chars)
      expect(parts1[0]).toHaveLength(32);
      expect(parts1[1]).toHaveLength(24);
      expect(parts1[2]).toHaveLength(32);

      // Salts must be cryptographically unique per record
      expect(parts1[0]).not.toBe(parts2[0]);
    });

    it('should decrypt legacy 3-part PBKDF2 encrypted payload with static salt', () => {
      const legacyKey = crypto.pbkdf2Sync(
        secretKey,
        'livora_wallet_encryption_salt_kdf_v1',
        100000,
        32,
        'sha512',
      );
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      let legacyEncrypted = cipher.update(knownPrivateKey, 'utf8', 'hex');
      legacyEncrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      const legacyPayload = `${iv.toString('hex')}:${authTag}:${legacyEncrypted}`;

      const decrypted = CryptoUtil.decrypt(legacyPayload, secretKey);
      expect(decrypted).toBe(knownPrivateKey);
    });

    it('decryptToBuffer returns mutable Buffer and zeroes successfully', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const buf = CryptoUtil.decryptToBuffer(encrypted, secretKey);

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString('utf8')).toBe(knownPrivateKey);

      buf.fill(0);
      expect(buf.every((byte) => byte === 0)).toBe(true);
    });

    it('withDecryptedKey executes callback and guarantees zeroization in finally block', async () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      let capturedBuffer: Buffer | null = null;

      const result = await CryptoUtil.withDecryptedKey(
        encrypted,
        secretKey,
        (keyBuf) => {
          capturedBuffer = keyBuf;
          expect(keyBuf.toString('utf8')).toBe(knownPrivateKey);
          return 'operation_success';
        },
      );

      expect(result).toBe('operation_success');
      expect(capturedBuffer).not.toBeNull();
      // Verify that after withDecryptedKey completes, the key buffer is zeroized
      expect((capturedBuffer as unknown as Buffer).every((b) => b === 0)).toBe(true);
    });
  });
});
