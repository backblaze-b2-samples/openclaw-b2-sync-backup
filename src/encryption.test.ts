import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt, isEncrypted } from "./encryption.js";

describe("encryption", () => {
  const appKey = "K004testapplicationkey1234567890ab";

  describe("deriveKey", () => {
    it("produces a 32-byte key", () => {
      const salt = crypto.randomBytes(32);
      const key = deriveKey(appKey, salt);
      expect(key.length).toBe(32);
    });

    it("produces different keys for different salts", () => {
      const salt1 = Buffer.alloc(32, 1);
      const salt2 = Buffer.alloc(32, 2);
      const key1 = deriveKey(appKey, salt1);
      const key2 = deriveKey(appKey, salt2);
      expect(key1.equals(key2)).toBe(false);
    });

    it("produces same key for same inputs", () => {
      const salt = Buffer.alloc(32, 42);
      const key1 = deriveKey(appKey, salt);
      const key2 = deriveKey(appKey, salt);
      expect(key1.equals(key2)).toBe(true);
    });
  });

  describe("encrypt / decrypt", () => {
    it("round-trips plaintext", () => {
      const plaintext = Buffer.from("hello openclaw");
      const encrypted = encrypt(plaintext, appKey);
      const decrypted = decrypt(encrypted, appKey);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("round-trips empty buffer", () => {
      const plaintext = Buffer.alloc(0);
      const encrypted = encrypt(plaintext, appKey);
      const decrypted = decrypt(encrypted, appKey);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("round-trips large binary data", () => {
      const plaintext = crypto.randomBytes(1024 * 64);
      const encrypted = encrypt(plaintext, appKey);
      const decrypted = decrypt(encrypted, appKey);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("produces different ciphertext for same plaintext (random salt/IV)", () => {
      const plaintext = Buffer.from("same data");
      const enc1 = encrypt(plaintext, appKey);
      const enc2 = encrypt(plaintext, appKey);
      expect(enc1.equals(enc2)).toBe(false);
    });

    it("fails to decrypt with wrong key", () => {
      const plaintext = Buffer.from("secret data");
      const encrypted = encrypt(plaintext, appKey);
      expect(() => decrypt(encrypted, "wrong-key-entirely")).toThrow();
    });

    it("fails to decrypt tampered ciphertext", () => {
      const plaintext = Buffer.from("important data");
      const encrypted = encrypt(plaintext, appKey);
      // Tamper with the ciphertext portion (after the 64-byte header)
      encrypted[65] = encrypted[65]! ^ 0xff;
      expect(() => decrypt(encrypted, appKey)).toThrow();
    });
  });

  describe("isEncrypted", () => {
    it("returns true for encrypted data", () => {
      const encrypted = encrypt(Buffer.from("test"), appKey);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("returns false for plaintext", () => {
      expect(isEncrypted(Buffer.from("just plain text"))).toBe(false);
    });

    it("returns false for short buffers", () => {
      expect(isEncrypted(Buffer.alloc(10))).toBe(false);
    });

    it("returns false for empty buffer", () => {
      expect(isEncrypted(Buffer.alloc(0))).toBe(false);
    });
  });
});
