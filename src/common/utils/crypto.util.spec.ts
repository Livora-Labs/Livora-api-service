import { CryptoUtil } from './crypto.util';

describe('CryptoUtil', () => {
  const knownPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const secretKey = 'testSecretKey32CharacterLength!';

  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt a private key correctly (round-trip)', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const decrypted = CryptoUtil.decrypt(encrypted, secretKey);
      
      expect(decrypted).toBe(knownPrivateKey);
    });

    it('should produce different ciphertexts for same plaintext (random IV)', () => {
      const encrypted1 = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const encrypted2 = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should throw on decrypt with wrong secret key', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      
      expect(() => {
        CryptoUtil.decrypt(encrypted, 'wrongSecretKey32CharacterLength!');
      }).toThrow();
    });

    it('should throw on invalid encrypted format (missing colon-separated parts)', () => {
      expect(() => {
        CryptoUtil.decrypt('invalidformat', secretKey);
      }).toThrow('Invalid encrypted text format');
    });

    it('should NOT expose plaintext in the encrypted output', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      
      expect(encrypted).not.toContain(knownPrivateKey);
    });

    it('encrypted key should not be stored in memory after decrypt call', () => {
      const encrypted = CryptoUtil.encrypt(knownPrivateKey, secretKey);
      const decrypted = CryptoUtil.decrypt(encrypted, secretKey);
      
      // We check that static properties on CryptoUtil don't hold the plaintext
      expect(Object.values(CryptoUtil)).not.toContain(decrypted);
    });
  });
});
