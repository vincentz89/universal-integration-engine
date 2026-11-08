import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AxiosHeaders } from "axios";
import type {
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

import { prisma } from "../../src/shared/utils/db.js";
import { encryptCredential } from "../../src/shared/security/credential-encryption.js";
import { createBigCommerceClient } from "../../src/infra/connectors/bigcommerce.js";

function createCaptureAdapter(
  capture: (token: unknown) => void,
) {
  return async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse> => {
    capture(AxiosHeaders.from(config.headers).get("X-Auth-Token"));

    return {
      data: { success: true },
      status: 200,
      statusText: "OK",
      headers: new AxiosHeaders(),
      config,
    };
  };
}

async function main() {
  const tenantAId = randomUUID();
  const tenantBId = randomUUID();

  const integrationAId = randomUUID();
  const integrationBId = randomUUID();

  const tokenA = `test-token-a-${randomUUID()}`;
  const tokenB = `test-token-b-${randomUUID()}`;

  const encryptedCredentialsA = encryptCredential(
    JSON.stringify({ accessToken: tokenA }),
  );

  const encryptedCredentialsB = encryptCredential(
    JSON.stringify({ accessToken: tokenB }),
  );

  const bigCommerceAuthConfig = {
    headerName: "X-Auth-Token",
    scheme: "",
  };

  console.info("======================================");
  console.info("BIGCOMMERCE TENANT ISOLATION TEST");
  console.info("======================================");

  try {
    // 1. Create two independent tenants.
    await prisma.tenantConfig.createMany({
      data: [
        {
          id: tenantAId,
        },
        {
          id: tenantBId,
        },
      ],
    });

    // 2. Create separate encrypted BigCommerce integrations.
    await prisma.tenantIntegrationConfig.createMany({
      data: [
        {
          id: integrationAId,
          tenantId: tenantAId,
          systemName: "BIGCOMMERCE",
          baseUrl:
            "https://api.bigcommerce.com/stores/test-store-a/v3",
          authType: "BEARER",
          authConfig: bigCommerceAuthConfig,
          credentialsEncrypted: encryptedCredentialsA,
          isActive: true,
        },
        {
          id: integrationBId,
          tenantId: tenantBId,
          systemName: "BIGCOMMERCE",
          baseUrl:
            "https://api.bigcommerce.com/stores/test-store-b/v3",
          authType: "BEARER",
          authConfig: bigCommerceAuthConfig,
          credentialsEncrypted: encryptedCredentialsB,
          isActive: true,
        },
      ],
    });

    console.info("[Test] Two tenants and encrypted integrations created.");

    // 3. Verify that plaintext credentials are not stored in the database.
    const storedIntegrationA =
      await prisma.tenantIntegrationConfig.findUniqueOrThrow({
        where: { id: integrationAId },
        select: { credentialsEncrypted: true },
      });

    assert.ok(storedIntegrationA.credentialsEncrypted);
    assert.notEqual(storedIntegrationA.credentialsEncrypted, tokenA);
    assert.ok(
      !storedIntegrationA.credentialsEncrypted.includes(tokenA),
      "Database must not contain the plaintext access token.",
    );

    console.info("[PASS] Credentials stored in encrypted form.");

    // 4. Verify that each tenant receives its own API client.
    const clientA = await createBigCommerceClient(
      tenantAId,
      integrationAId,
    );

    const clientB = await createBigCommerceClient(
      tenantBId,
      integrationBId,
    );

    assert.notStrictEqual(
      clientA,
      clientB,
      "Each tenant must receive a separate Axios instance.",
    );

    console.info("[PASS] Separate Axios instances.");

    // 5. Verify that credentials are not stored in Axios defaults.
    const defaultTokenA = AxiosHeaders.from(
      clientA.defaults.headers,
    ).get("X-Auth-Token");

    const defaultTokenB = AxiosHeaders.from(
      clientB.defaults.headers,
    ).get("X-Auth-Token");

    assert.equal(defaultTokenA, undefined);
    assert.equal(defaultTokenB, undefined);

    console.info("[PASS] Credentials are not exposed in Axios defaults.");

    // 6. Inspect actual outgoing requests using mock adapters.
    let outgoingTokenA: unknown;
    let outgoingTokenB: unknown;

    clientA.defaults.adapter = createCaptureAdapter((token) => {
      outgoingTokenA = token;
    });

    clientB.defaults.adapter = createCaptureAdapter((token) => {
      outgoingTokenB = token;
    });

    await clientA.get("/catalog/products");
    await clientB.get("/catalog/products");

    assert.equal(outgoingTokenA, tokenA);
    assert.equal(outgoingTokenB, tokenB);
    assert.notEqual(outgoingTokenA, outgoingTokenB);

    console.info("[PASS] Tenant-specific authentication headers applied.");

    // 7. Verify that each client uses its own store URL.
    assert.equal(
      clientA.defaults.baseURL,
      "https://api.bigcommerce.com/stores/test-store-a/v3",
    );

    assert.equal(
      clientB.defaults.baseURL,
      "https://api.bigcommerce.com/stores/test-store-b/v3",
    );

    console.info("[PASS] Tenant-specific API base URLs.");

    // 8. Verify that cross-tenant integration access is rejected.
    await assert.rejects(
      () => createBigCommerceClient(tenantAId, integrationBId),
      /Active BIGCOMMERCE integration not found for tenant/,
    );

    console.info("[PASS] Cross-tenant integration access rejected.");

    // 9. Verify that missing access tokens are rejected during authentication.
    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        credentialsEncrypted: encryptCredential(
          JSON.stringify({ accessToken: "" }),
        ),
      },
    });

    await assert.rejects(
      () => clientA.get("/catalog/products"),
      /Bearer authentication access token is missing/,
    );

    console.info("[PASS] Missing access token rejected.");

    // Restore Tenant A's encrypted credentials.
    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        credentialsEncrypted: encryptedCredentialsA,
      },
    });

    // 10. Verify that an untrusted API hostname is rejected.
    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        baseUrl:
          "https://malicious.example.com/stores/test-store-a/v3",
      },
    });

    await assert.rejects(
      () => createBigCommerceClient(tenantAId, integrationAId),
      /official HTTPS API hostname/,
    );

    console.info("[PASS] Untrusted API hostname rejected.");

    // 11. Verify that an invalid API path is rejected.
    await prisma.tenantIntegrationConfig.update({
      where: { id: integrationAId },
      data: {
        baseUrl: "https://api.bigcommerce.com/v2",
      },
    });

    await assert.rejects(
      () => createBigCommerceClient(tenantAId, integrationAId),
      /Invalid BigCommerce API base URL path/,
    );

    console.info("[PASS] Invalid API path rejected.");

    console.info("--------------------------------------");
    console.info("FINAL RESULT: ALL TESTS PASSED");
    console.info("======================================");
  } finally {
    await prisma.tenantIntegrationConfig.deleteMany({
      where: {
        id: {
          in: [integrationAId, integrationBId],
        },
      },
    });

    await prisma.tenantConfig.deleteMany({
      where: {
        id: {
          in: [tenantAId, tenantBId],
        },
      },
    });

    await prisma.$disconnect();

    console.info("[Test] Database resources cleaned up.");
  }
}

main().catch((error: unknown) => {
  console.error("BIGCOMMERCE TENANT ISOLATION TEST FAILED:", error);
  process.exitCode = 1;
});