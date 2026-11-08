
import "dotenv/config";

import assert from "node:assert/strict";

import { prisma } from "../../src/shared/utils/db.js";
import {
  tenantCredentialService,
} from "../../src/shared/services/tenant-credential.service.js";

async function main(): Promise<void> {
  let passed = 0;

  const tenant = await prisma.tenantConfig.create({
    data: {
    },
  });

  const integration = await prisma.tenantIntegrationConfig.create({
    data: {
      tenantId: tenant.id,
      systemName: "BIGCOMMERCE",
      baseUrl: "https://api.bigcommerce.com/stores/test-store/v3",
      authType: "BEARER",
      isActive: true,
    },
  });

  function pass(message: string): void {
    console.log(`[PASS] ${message}`);
    passed++;
  }

    // 0. Validate identifiers before retrieving integration credentials.

  // Reject an empty tenant ID.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        "",
        integration.id,
        "BIGCOMMERCE",
      ),
    /Tenant ID is required/,
  );

  pass("Empty tenant ID rejected during credential retrieval.");

  // Reject a whitespace-only tenant ID.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        "   ",
        integration.id,
        "BIGCOMMERCE",
      ),
    /Tenant ID is required/,
  );

  pass("Whitespace-only tenant ID rejected during credential retrieval.");

  // Reject an empty integration ID.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        tenant.id,
        "",
        "BIGCOMMERCE",
      ),
    /Integration ID is required/,
  );

  pass("Empty integration ID rejected during credential retrieval.");

  // Reject a whitespace-only integration ID.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        tenant.id,
        "   ",
        "BIGCOMMERCE",
      ),
    /Integration ID is required/,
  );

  pass("Whitespace-only integration ID rejected during credential retrieval.");

  // Reject an empty expected system name.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        tenant.id,
        integration.id,
        "",
      ),
    /System name is required/,
  );

  pass("Empty system name rejected during credential retrieval.");

  // Reject a whitespace-only expected system name.
  await assert.rejects(
    () =>
      tenantCredentialService.getIntegrationCredentials(
        tenant.id,
        integration.id,
        "   ",
      ),
    /System name is required/,
  );

  pass("Whitespace-only system name rejected during credential retrieval.");

  try {
    // 1. Save and retrieve custom Bearer configuration.
    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenant.id,
      integrationId: integration.id,
      expectedSystemName: "BIGCOMMERCE",
      authType: "BEARER",
      credentials: {
        accessToken: "test-bigcommerce-token",
      },
      authConfig: {
        headerName: "X-Auth-Token",
        scheme: "",
      },
    });

    let saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.deepEqual(saved.authConfig, {
      headerName: "X-Auth-Token",
      scheme: "",
    });

    assert.equal(
      saved.credentials.accessToken,
      "test-bigcommerce-token",
    );

    pass("Custom Bearer configuration saved and retrieved.");

    // 2. Reject unsupported Bearer configuration fields.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "BEARER",
          credentials: {
            accessToken: "another-token",
          },
          authConfig: {
            headerName: "X-Auth-Token",
            scheme: "",
            arbitraryOption: true,
          },
        }),
      /Unsupported Bearer authentication configuration field/,
    );

    pass("Unsupported Bearer configuration field rejected.");

    // 3. Reject invalid Bearer header names.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "BEARER",
          credentials: {
            accessToken: "another-token",
          },
          authConfig: {
            headerName: "Invalid Header Name",
            scheme: "",
          },
        }),
      /Invalid BEARER authentication header name/,
    );

    pass("Invalid Bearer header name rejected.");

    // 4. Reject custom configuration for unsupported auth types.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "BASIC",
          credentials: {
            username: "test",
            password: "test",
          },
          authConfig: {
            headerName: "X-Auth-Token",
          },
        }),
      /Custom authentication configuration is not supported/,
    );

    pass("Unsupported authentication type configuration rejected.");

    // 5. Verify failed updates did not overwrite Bearer credentials.
    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.deepEqual(saved.authConfig, {
      headerName: "X-Auth-Token",
      scheme: "",
    });

    assert.equal(
      saved.credentials.accessToken,
      "test-bigcommerce-token",
    );

    pass("Failed Bearer updates did not modify saved credentials.");

    // 6. Save and retrieve API_KEY HEADER configuration.
    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenant.id,
      integrationId: integration.id,
      expectedSystemName: "BIGCOMMERCE",
      authType: "API_KEY",
      credentials: {
        apiKey: "test-api-key",
        apiSecret: "test-api-secret",
      },
      authConfig: {
        location: "HEADER",
        parameterName: "X-API-Key",
        secretHeaderName: "X-API-Secret",
      },
    });

    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.deepEqual(saved.authConfig, {
      location: "HEADER",
      parameterName: "X-API-Key",
      secretHeaderName: "X-API-Secret",
    });

    assert.equal(saved.authType, "API_KEY");
    assert.equal(saved.credentials.apiKey, "test-api-key");
    assert.equal(saved.credentials.apiSecret, "test-api-secret");

    pass("API_KEY HEADER configuration saved and retrieved.");

    // 7. Save and retrieve API_KEY QUERY configuration.
    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenant.id,
      integrationId: integration.id,
      expectedSystemName: "BIGCOMMERCE",
      authType: "API_KEY",
      credentials: {
        apiKey: "test-query-api-key",
      },
      authConfig: {
        location: "QUERY",
        parameterName: "api_key",
      },
    });

    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.deepEqual(saved.authConfig, {
      location: "QUERY",
      parameterName: "api_key",
    });

    assert.equal(saved.credentials.apiKey, "test-query-api-key");

    pass("API_KEY QUERY configuration saved and retrieved.");

    // 8. Reject unsupported API_KEY configuration fields.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: "another-key",
          },
          authConfig: {
            location: "QUERY",
            parameterName: "api_key",
            arbitraryOption: true,
          },
        }),
      /Unsupported API key authentication configuration field/,
    );

    pass("Unsupported API_KEY configuration field rejected.");

    // 9. Reject invalid API_KEY authentication location.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: "another-key",
          },
          authConfig: {
            location: "COOKIE",
            parameterName: "api_key",
          },
        }),
      /API key authentication location must be HEADER or QUERY/,
    );

    pass("Invalid API_KEY authentication location rejected.");

    // 10. Reject invalid API_KEY header names.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: "another-key",
          },
          authConfig: {
            location: "HEADER",
            parameterName: "Invalid Header Name",
          },
        }),
      /Invalid API_KEY authentication header name/,
    );

    pass("Invalid API_KEY header name rejected.");

    // 11. Reject secret header configuration for QUERY authentication.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: "another-key",
          },
          authConfig: {
            location: "QUERY",
            parameterName: "api_key",
            secretHeaderName: "X-API-Secret",
          },
        }),
      /API secret header configuration requires HEADER authentication/,
    );

    pass("Secret header configuration rejected for QUERY authentication.");

    // 12. Reject identical API key and API secret header names.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: "another-key",
            apiSecret: "another-secret",
          },
          authConfig: {
            location: "HEADER",
            parameterName: "X-API-Key",
            secretHeaderName: "x-api-key",
          },
        }),
      /API key and API secret must use different headers/,
    );

    pass("Duplicate API key and secret header names rejected.");

    // 13. Verify failed API_KEY updates did not overwrite saved credentials.
    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.equal(saved.authType, "API_KEY");

    assert.deepEqual(saved.authConfig, {
      location: "QUERY",
      parameterName: "api_key",
    });

    assert.equal(
      saved.credentials.apiKey,
      "test-query-api-key",
    );

    pass("Failed API_KEY updates did not modify saved credentials.");

        // 14. Reject an array instead of a credential object.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: [] as unknown as Record<string, string>,
        }),
      /Integration credentials must be an object/,
    );

    pass("Array credential payload rejected.");

    // 15. Reject null instead of a credential object.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: null as unknown as Record<string, string>,
        }),
      /Integration credentials must be an object/,
    );

    pass("Null credential payload rejected.");

    // 16. Reject non-string credential values.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            apiKey: 123,
          } as unknown as Record<string, string>,
        }),
      /Integration credential field "apiKey" must be a string/,
    );

    pass("Non-string credential values rejected.");

    // 17. Reject blank credential field names.
    await assert.rejects(
      () =>
        tenantCredentialService.saveIntegrationCredentials({
          tenantId: tenant.id,
          integrationId: integration.id,
          expectedSystemName: "BIGCOMMERCE",
          authType: "API_KEY",
          credentials: {
            "   ": "invalid-value",
          },
        }),
      /Credential field names cannot be empty/,
    );

    pass("Blank credential field names rejected.");

    // 18. Verify rejected payloads did not overwrite saved credentials.
    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.equal(saved.authType, "API_KEY");
    assert.deepEqual(saved.authConfig, {
      location: "QUERY",
      parameterName: "api_key",
    });
    assert.equal(saved.credentials.apiKey, "test-query-api-key");

    pass("Rejected credential payloads did not modify saved credentials.");

        // 19. Omitted authConfig must preserve the existing configuration.
    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenant.id,
      integrationId: integration.id,
      expectedSystemName: "BIGCOMMERCE",
      authType: "API_KEY",
      credentials: {
        apiKey: "rotated-query-api-key",
      },
    });

    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.deepEqual(saved.authConfig, {
      location: "QUERY",
      parameterName: "api_key",
    });

    assert.equal(
      saved.credentials.apiKey,
      "rotated-query-api-key",
    );

    pass("Omitted authConfig preserves existing configuration during credential rotation.");

    // 20. Explicit null must clear the existing configuration.
    await tenantCredentialService.saveIntegrationCredentials({
      tenantId: tenant.id,
      integrationId: integration.id,
      expectedSystemName: "BIGCOMMERCE",
      authType: "API_KEY",
      credentials: {
        apiKey: "test-query-api-key",
      },
      authConfig: null,
    });

    saved = await tenantCredentialService.getIntegrationCredentials(
      tenant.id,
      integration.id,
      "BIGCOMMERCE",
    );

    assert.equal(saved.authConfig, null);

    assert.equal(
      saved.credentials.apiKey,
      "test-query-api-key",
    );

    pass("Explicit null clears authentication configuration.");

    console.log("--------------------------------------");
    console.log(`PASSED: ${passed}`);
    console.log("FAILED: 0");
    console.log("FINAL RESULT: ALL TESTS PASSED");
  } finally {
    await prisma.tenantConfig.delete({
      where: { id: tenant.id },
    });

    await prisma.$disconnect();

    console.log("[Test] Database resources cleaned up.");
  }
}

main().catch(async (error: unknown) => {
  console.error("TEST FAILURE:", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
