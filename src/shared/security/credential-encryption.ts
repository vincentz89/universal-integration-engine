
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_ENV_NAME = "CREDENTIAL_ENCRYPTION_KEY";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_VERSION = "v1";

function getEncryptionKey(): Buffer {
  const configuredKey = process.env[KEY_ENV_NAME];

  if (!configuredKey) {
    throw new Error(
      `${KEY_ENV_NAME} environment variable is required.`,
    );
  }

  // The key must be exactly 64 hexadecimal characters (32 bytes).
  if (!/^[a-fA-F0-9]{64}$/.test(configuredKey)) {
    throw new Error(
      `${KEY_ENV_NAME} must contain exactly 64 hexadecimal characters.`,
    );
  }

  const key = Buffer.from(configuredKey, "hex");

  if (key.length !== 32) {
    throw new Error("Invalid credential encryption key length.");
  }

  return key;
}

/**
 * Encrypts a plaintext credential using AES-256-GCM.
 *
 * Envelope format:
 * v1.<iv-base64url>.<auth-tag-base64url>.<ciphertext-base64url>
 */
export function encryptCredential(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Credential plaintext must not be empty.");
  }

  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts and authenticates an AES-256-GCM credential envelope.
 *
 * Decryption fails if the ciphertext or authentication tag is modified,
 * or if the wrong encryption key is configured.
 */
export function decryptCredential(envelope: string): string {
  if (typeof envelope !== "string" || envelope.length === 0) {
    throw new Error("Encrypted credential must not be empty.");
  }

  const parts = envelope.split(".");

  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("Unsupported or malformed credential envelope.");
  }

  // Validate the Base64URL components before decoding.
  const ivEncoded = parts[1];
  const authTagEncoded = parts[2];
  const ciphertextEncoded = parts[3];

  if (
    typeof ivEncoded !== "string" ||
    typeof authTagEncoded !== "string" ||
    typeof ciphertextEncoded !== "string"
  ) {
    throw new Error("Malformed credential envelope.");
  }

  // Validate the Base64URL components before decoding.
  const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

  if (
    !base64UrlPattern.test(ivEncoded) ||
    !base64UrlPattern.test(authTagEncoded) ||
    !base64UrlPattern.test(ciphertextEncoded)
  ) {
    throw new Error("Malformed credential envelope encoding.");
  }

  const iv = Buffer.from(ivEncoded, "base64url");
  const authTag = Buffer.from(authTagEncoded, "base64url");
  const ciphertext = Buffer.from(ciphertextEncoded, "base64url");

  if (
    iv.length !== IV_LENGTH ||
    authTag.length !== AUTH_TAG_LENGTH
  ) {
    throw new Error("Malformed credential envelope dimensions.");
  }

  const key = getEncryptionKey();

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } catch {
    // Do not expose cryptographic internals or credential data.
    throw new Error(
      "Credential decryption failed. Verify the encryption key and ciphertext integrity.",
    );
  }
}
