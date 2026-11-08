
import { Prisma } from "@prisma/client";
import type { IntegrationAuthType } from "@prisma/client";

import {
  decryptCredential,
  encryptCredential,
} from "../security/credential-encryption.js";

import { prisma } from "../utils/db.js";

export type IntegrationCredentialPayload = Record<string, string>;

export interface TenantIntegrationCredentials {
  id: string;
  tenantId: string;
  systemName: string;
  baseUrl: string | null;
  authType: IntegrationAuthType;
  authConfig: Record<string, unknown> | null;
  credentials: IntegrationCredentialPayload;
}

export interface TenantIntegrationMetadata {
  id: string;
  tenantId: string;
  systemName: string;
  baseUrl: string | null;
}

export interface SaveIntegrationCredentialsInput {
  tenantId: string;
  integrationId: string;
  expectedSystemName: string;
  authType: IntegrationAuthType;
  credentials: IntegrationCredentialPayload;
  authConfig?: Record<string, unknown> | null;
}

function validateIdentifier(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
}

function validateCredentialPayload(
  credentials: IntegrationCredentialPayload,
): void {
  if (
    typeof credentials !== "object" ||
    credentials === null ||
    Array.isArray(credentials)
  ) {
    throw new Error("Integration credentials must be an object.");
  }

  for (const [key, value] of Object.entries(credentials)) {
    if (key.trim().length === 0) {
      throw new Error("Credential field names cannot be empty.");
    }

    if (typeof value !== "string") {
      throw new Error(
        `Integration credential field "${key}" must be a string.`,
      );
    }
  }
}


function validateAuthConfig(
  authType: IntegrationAuthType,
  value: Record<string, unknown> | null | undefined,
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "Integration authentication configuration is invalid.",
    );
  }

  const reservedHeaders = new Set([
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "proxy-authorization",
    "authorization",
  ]);

  function validateHeaderName(
    headerName: unknown,
    fieldName: string,
    allowAuthorization = false,
  ): void {
    if (
      typeof headerName !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName.trim()) ||
      (
        reservedHeaders.has(headerName.trim().toLowerCase()) &&
        !(allowAuthorization && headerName.trim().toLowerCase() === "authorization")
      )
    ) {
      const readableFieldName =
        fieldName === "headerName" ? "header name" : fieldName;

      throw new Error(
        `Invalid ${authType} authentication ${readableFieldName}.`,
      );
    }
  }

  if (authType === "BEARER") {
    const allowedKeys = new Set(["headerName", "scheme"]);

    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new Error(
          `Unsupported Bearer authentication configuration field: ${key}.`,
        );
      }
    }

    if (value.headerName !== undefined) {
      validateHeaderName(value.headerName, "headerName", true);
    }

    if (value.scheme !== undefined) {
      if (
        typeof value.scheme !== "string" ||
        value.scheme.length > 64 ||
        (
          value.scheme.length > 0 &&
          !/^[A-Za-z][A-Za-z0-9._~-]*$/.test(value.scheme)
        )
      ) {
        throw new Error("Invalid Bearer authentication scheme.");
      }
    }

    return;
  }

  if (authType === "API_KEY") {
    const allowedKeys = new Set([
      "location",
      "parameterName",
      "secretHeaderName",
    ]);

    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new Error(
          `Unsupported API key authentication configuration field: ${key}.`,
        );
      }
    }

    const location = value.location ?? "HEADER";

    if (location !== "HEADER" && location !== "QUERY") {
      throw new Error(
        "API key authentication location must be HEADER or QUERY.",
      );
    }

    if (value.parameterName !== undefined) {
      if (
        typeof value.parameterName !== "string" ||
        value.parameterName.trim().length === 0
      ) {
        throw new Error("Invalid API key parameter name.");
      }

      if (location === "HEADER") {
        validateHeaderName(value.parameterName, "header name");
      }
    }


    if (value.secretHeaderName !== undefined) {
      const secretHeaderName = value.secretHeaderName;

      if (location !== "HEADER") {
        throw new Error(
          "API secret header configuration requires HEADER authentication.",
        );
      }

      validateHeaderName(
        secretHeaderName,
        "secret header name",
      );

      const parameterName =
        typeof value.parameterName === "string"
          ? value.parameterName.trim()
          : "X-API-Key";

      if (
        typeof secretHeaderName === "string" &&
        secretHeaderName.trim().toLowerCase() ===
          parameterName.toLowerCase()
      ) {
        throw new Error(
          "API key and API secret must use different headers.",
        );
      }
    }


    return;
  }

  throw new Error(
    `Custom authentication configuration is not supported for ${authType}.`,
  );
}

function parseCredentialPayload(
  encryptedPayload: string | null,
): IntegrationCredentialPayload {
  if (!encryptedPayload) {
    return {};
  }

  const plaintext = decryptCredential(encryptedPayload);

  let parsed: unknown;

  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Integration credential payload is invalid JSON.");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("Integration credential payload must be an object.");
  }

  const entries = Object.entries(parsed);

  for (const [key, value] of entries) {
    if (key.trim().length === 0) {
      throw new Error("Credential field names cannot be empty.");
    }

    if (typeof value !== "string") {
      throw new Error(
        `Integration credential field "${key}" must be a string.`,
      );
    }
  }

  return Object.fromEntries(entries) as IntegrationCredentialPayload;
}

function parseAuthConfig(
  value: unknown,
  authType: IntegrationAuthType,
): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Integration authentication configuration is invalid.");
  }

  const authConfig = value as Record<string, unknown>;

  validateAuthConfig(authType, authConfig);

  return authConfig;
}

export class TenantCredentialService {
  /**
   * Retrieves non-secret integration metadata without decrypting credentials.
   *
   * Every lookup is scoped by tenant ID, integration ID, and provider.
   */
  async getIntegrationMetadata(
    tenantId: string,
    integrationId: string,
    expectedSystemName: string,
  ): Promise<TenantIntegrationMetadata> {
    validateIdentifier(tenantId, "Tenant ID");
    validateIdentifier(integrationId, "Integration ID");
    validateIdentifier(expectedSystemName, "System name");

    const config = await prisma.tenantIntegrationConfig.findFirst({
      where: {
        id: integrationId,
        tenantId,
        isActive: true,
        systemName: expectedSystemName,
      },
      select: {
        id: true,
        tenantId: true,
        systemName: true,
        baseUrl: true,
      },
    });

    if (!config) {
      throw new Error(
        `Active ${expectedSystemName} integration not found for tenant.`,
      );
    }

    return config;
  }

  /**
   * Retrieves and decrypts credentials for one active tenant integration.
   *
   * Every lookup is scoped by tenant ID, integration ID, and provider.
   * Decrypted credentials exist only in application memory.
   */
  async getIntegrationCredentials(
    tenantId: string,
    integrationId: string,
    expectedSystemName: string,
  ): Promise<TenantIntegrationCredentials> {
    validateIdentifier(tenantId, "Tenant ID");
    validateIdentifier(integrationId, "Integration ID");
    validateIdentifier(expectedSystemName, "System name");

    const config = await prisma.tenantIntegrationConfig.findFirst({
      where: {
        id: integrationId,
        tenantId,
        isActive: true,
        systemName: expectedSystemName,
      },
      select: {
        id: true,
        tenantId: true,
        systemName: true,
        baseUrl: true,
        authType: true,
        authConfig: true,
        credentialsEncrypted: true,
      },
    });

    if (!config) {
      throw new Error(
        `Active ${expectedSystemName} integration not found for tenant.`,
      );
    }

    return {
      id: config.id,
      tenantId: config.tenantId,
      systemName: config.systemName,
      baseUrl: config.baseUrl,
      authType: config.authType,
      authConfig: parseAuthConfig(config.authConfig, config.authType),
      credentials: parseCredentialPayload(config.credentialsEncrypted),
    };
  }

  /**
   * Encrypts and saves credentials for an existing tenant integration.
   *
   * The database update is scoped by integration ID, tenant ID,
   * and expected provider name.
   */
  async saveIntegrationCredentials(
    input: SaveIntegrationCredentialsInput,
  ): Promise<void> {
    validateIdentifier(input.tenantId, "Tenant ID");
    validateIdentifier(input.integrationId, "Integration ID");
    validateIdentifier(input.expectedSystemName, "System name");

    // Validate credential values before serialization and encryption.
    validateCredentialPayload(input.credentials);

    validateAuthConfig(input.authType, input.authConfig);

    const encryptedPayload = encryptCredential(
      JSON.stringify(input.credentials),
    );

    const result = await prisma.tenantIntegrationConfig.updateMany({
      where: {
        id: input.integrationId,
        tenantId: input.tenantId,
        systemName: input.expectedSystemName,
      },
      data: {
        authType: input.authType,
        credentialsEncrypted: encryptedPayload,

        // Preserve existing authentication configuration when omitted.
        // Explicit null clears the configuration.
        // An object replaces the existing configuration.
        ...(input.authConfig === undefined
          ? {}
          : {
              authConfig:
                input.authConfig === null
                  ? Prisma.DbNull
                  : (input.authConfig as Prisma.InputJsonValue),
            }),

        // Invalidate the existing access-token expiry after
        // manually replacing authentication credentials.
        tokenType: null,
        accessTokenExpiresAt: null,

        // Release any refresh ownership associated with old credentials.
        tokenRefreshLockToken: null,
        tokenRefreshLockExpiresAt: null,
      },
    });

    if (result.count !== 1) {
      throw new Error(
        "Integration not found or does not belong to the specified tenant.",
      );
    }
  }
}

export const tenantCredentialService = new TenantCredentialService();
