
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "dotenv/config";

import {
  encryptCredential,
  decryptCredential,
} from "../../src/shared/security/credential-encryption.js";

const KEY_ENV_NAME = "CREDENTIAL_ENCRYPTION_KEY";

let passed = 0;
let failed = 0;

function test(name: string, callback: () => void): void {
  try {
    callback();
    passed++;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(
      error instanceof Error ? error.message : "Unknown test error.",
    );
  }
}

function expectDecryptionFailure(envelope: string): void {
  assert.throws(
    () => decryptCredential(envelope),
    /Credential decryption failed|Malformed|Unsupported/,
  );
}

function mutateBase64Url(value: string): string {
  const first = value[0];
  const replacement = first === "A" ? "B" : "A";

  return replacement + value.slice(1);
}

async function main(): Promise<void> {
  const originalKey = process.env[KEY_ENV_NAME];

  // Use a temporary test key instead of depending on the production key.
  const testKeyA = randomBytes(32).toString("hex");
  const testKeyB = randomBytes(32).toString("hex");

  process.env[KEY_ENV_NAME] = testKeyA;

  console.log("======================================");
  console.log("CREDENTIAL ENCRYPTION SECURITY TEST");
  console.log("======================================");

  try {
    // 1. Encryption and decryption round-trip.
    test("Credential round-trip succeeds", () => {
      const plaintext = JSON.stringify({
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        webhookSecret: "test-webhook-secret",
      });

      const encrypted = encryptCredential(plaintext);
      const decrypted = decryptCredential(encrypted);

      assert.equal(decrypted, plaintext);
      assert.notEqual(encrypted, plaintext);
    });

    // 2. Envelope version and structure.
    test("Encrypted envelope uses the expected v1 format", () => {
      const encrypted = encryptCredential("test-secret");
      const parts = encrypted.split(".");

      assert.equal(parts.length, 4);
      assert.equal(parts[0], "v1");
    });

    // 3. Random IV uniqueness.
    test("Identical plaintext produces different ciphertexts", () => {
      const plaintext = "same-credential-value";

      const encryptedA = encryptCredential(plaintext);
      const encryptedB = encryptCredential(plaintext);

      assert.notEqual(encryptedA, encryptedB);
      assert.equal(decryptCredential(encryptedA), plaintext);
      assert.equal(decryptCredential(encryptedB), plaintext);

      const ivA = encryptedA.split(".")[1];
      const ivB = encryptedB.split(".")[1];

      assert.notEqual(ivA, ivB);
    });

    // 4. Ciphertext tampering.
    test("Modified ciphertext is rejected", () => {
      const encrypted = encryptCredential("sensitive-value");
      const parts = encrypted.split(".");

      const ciphertext = parts[3];

      assert.ok(ciphertext, "Ciphertext component must exist.");

      parts[3] = mutateBase64Url(ciphertext);

      expectDecryptionFailure(parts.join("."));
    });

    // 5. Authentication tag tampering.
    test("Modified authentication tag is rejected", () => {
      const encrypted = encryptCredential("sensitive-value");
      const parts = encrypted.split(".");

      const authTag = parts[2];

      assert.ok(authTag, "Authentication tag component must exist.");

      parts[2] = mutateBase64Url(authTag);

      expectDecryptionFailure(parts.join("."));
    });

    // 6. Wrong encryption key.
    test("Credentials encrypted with another key cannot be decrypted", () => {
      const encrypted = encryptCredential("sensitive-value");

      process.env[KEY_ENV_NAME] = testKeyB;

      assert.throws(
        () => decryptCredential(encrypted),
        /Credential decryption failed/,
      );

      process.env[KEY_ENV_NAME] = testKeyA;

      assert.equal(
        decryptCredential(encrypted),
        "sensitive-value",
      );
    });

    // 7. Unsupported envelope version.
    test("Unsupported envelope version is rejected", () => {
      const encrypted = encryptCredential("sensitive-value");
      const parts = encrypted.split(".");

      parts[0] = "v2";

      assert.throws(
        () => decryptCredential(parts.join(".")),
        /Unsupported or malformed/,
      );
    });

    // 8. Invalid Base64URL encoding.
    test("Malformed Base64URL components are rejected", () => {
      const encrypted = encryptCredential("sensitive-value");
      const parts = encrypted.split(".");

      parts[1] = "invalid@encoding";

      assert.throws(
        () => decryptCredential(parts.join(".")),
        /Malformed credential envelope encoding/,
      );
    });

    // 9. Invalid IV dimensions.
    test("Invalid initialization vector length is rejected", () => {
      const encrypted = encryptCredential("sensitive-value");
      const parts = encrypted.split(".");

      parts[1] = Buffer.from(randomBytes(8)).toString("base64url");

      assert.throws(
        () => decryptCredential(parts.join(".")),
        /Malformed credential envelope dimensions/,
      );
    });

    // 10. Missing encryption key.
    test("Missing encryption key is rejected", () => {
      delete process.env[KEY_ENV_NAME];

      assert.throws(
        () => encryptCredential("sensitive-value"),
        /environment variable is required/,
      );
    });

    // 11. Invalid encryption key format.
    test("Invalid encryption key format is rejected", () => {
      process.env[KEY_ENV_NAME] = "invalid-key";

      assert.throws(
        () => encryptCredential("sensitive-value"),
        /exactly 64 hexadecimal characters/,
      );
    });

    // 12. Empty plaintext.
    test("Empty plaintext is rejected", () => {
      process.env[KEY_ENV_NAME] = testKeyA;

      assert.throws(
        () => encryptCredential(""),
        /must not be empty/,
      );
    });

    // 13. Empty encrypted envelope.
    test("Empty encrypted envelope is rejected", () => {
      assert.throws(
        () => decryptCredential(""),
        /must not be empty/,
      );
    });
  } finally {
    // Restore the original environment without exposing its value.
    if (originalKey === undefined) {
      delete process.env[KEY_ENV_NAME];
    } else {
      process.env[KEY_ENV_NAME] = originalKey;
    }
  }

  console.log("--------------------------------------");
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("--------------------------------------");

  if (failed > 0) {
    process.exitCode = 1;
    console.log("FINAL RESULT: SECURITY TESTS FAILED");
  } else {
    console.log("FINAL RESULT: ALL SECURITY TESTS PASSED");
  }
}

main().catch((error) => {
  console.error("Security test execution failed:", error);
  process.exitCode = 1;
});
