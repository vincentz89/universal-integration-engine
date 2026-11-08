
import { Prisma } from "@prisma/client";

import { prisma } from "../utils/db.js";

export interface RegisterIntegrationInput {
  tenantId: string;
  systemName: string;
  externalAccountId: string;
  externalAccountKey: string;
  externalAccountMetadata?: Prisma.InputJsonObject;
  baseUrl?: string;
}

export interface RegisterIntegrationResult {
  integrationId: string;
  tenantId: string;
  systemName: string;
  externalAccountId: string;
  externalAccountKey: string;
  isActive: boolean;
  created: boolean;
}

export type IntegrationRegistrationErrorCode =
  | "INVALID_INPUT"
  | "TENANT_NOT_FOUND"
  | "TENANT_INACTIVE"
  | "ACCOUNT_ALREADY_OWNED"
  | "ACCOUNT_IDENTITY_MISMATCH";

export class IntegrationRegistrationError extends Error {
  constructor(
    public readonly code: IntegrationRegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationRegistrationError";
  }
}

function validateRequiredString(
  value: string,
  fieldName: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim()
  ) {
    throw new IntegrationRegistrationError(
      "INVALID_INPUT",
      `${fieldName} must be a non-empty string without surrounding whitespace.`,
    );
  }
}

function validateSystemName(systemName: string): void {
  validateRequiredString(systemName, "System name");

  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(systemName)) {
    throw new IntegrationRegistrationError(
      "INVALID_INPUT",
      "System name must use uppercase letters, numbers, and underscores.",
    );
  }
}

export class IntegrationRegistrationService {
  /**
   * Registers one verified external provider account for a tenant.
   *
   * Existing account ownership is never changed by this operation.
   * Credentials are managed separately by TenantCredentialService.
   */
  async register(
    input: RegisterIntegrationInput,
  ): Promise<RegisterIntegrationResult> {
    validateRequiredString(input.tenantId, "Tenant ID");
    validateSystemName(input.systemName);
    validateRequiredString(
      input.externalAccountId,
      "External account ID",
    );
    validateRequiredString(
      input.externalAccountKey,
      "External account key",
    );

    if (
      input.baseUrl !== undefined &&
      input.baseUrl.trim().length === 0
    ) {
      throw new IntegrationRegistrationError(
        "INVALID_INPUT",
        "Base URL cannot be empty when provided.",
      );
    }

    try {
      const integration = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenantConfig.findUnique({
          where: {
            id: input.tenantId,
          },
          select: {
            id: true,
            isActive: true,
          },
        });

        if (!tenant) {
          throw new IntegrationRegistrationError(
            "TENANT_NOT_FOUND",
            "Tenant does not exist.",
          );
        }

        if (!tenant.isActive) {
          throw new IntegrationRegistrationError(
            "TENANT_INACTIVE",
            "Cannot register an integration for an inactive tenant.",
          );
        }

        return tx.tenantIntegrationConfig.create({
          data: {
            tenantId: input.tenantId,
            systemName: input.systemName,
            externalAccountId: input.externalAccountId,
            externalAccountKey: input.externalAccountKey,

            ...(input.externalAccountMetadata !== undefined
              ? {
                  externalAccountMetadata:
                    input.externalAccountMetadata,
                }
              : {}),

            ...(input.baseUrl !== undefined
              ? {
                  baseUrl: input.baseUrl,
                }
              : {}),
          },
          select: {
            id: true,
            tenantId: true,
            systemName: true,
            externalAccountId: true,
            externalAccountKey: true,
            isActive: true,
          },
        });
      });

      return {
        integrationId: integration.id,
        tenantId: integration.tenantId,
        systemName: integration.systemName,
        externalAccountId: integration.externalAccountId!,
        externalAccountKey: integration.externalAccountKey!,
        isActive: integration.isActive,
        created: true,
      };
    } catch (error) {
      if (
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
      ) {
        throw error;
      }
    }

    // Resolve a concurrent registration using the provider-wide unique key.
    const existing = await prisma.tenantIntegrationConfig.findUnique({
      where: {
        systemName_externalAccountKey: {
          systemName: input.systemName,
          externalAccountKey: input.externalAccountKey,
        },
      },
      select: {
        id: true,
        tenantId: true,
        systemName: true,
        externalAccountId: true,
        externalAccountKey: true,
        isActive: true,
      },
    });

    // The unique conflict may have originated from another constraint.
    if (!existing) {
      throw new Error(
        "Integration registration failed because of an unexpected database uniqueness conflict.",
      );
    }

    if (existing.tenantId !== input.tenantId) {
      throw new IntegrationRegistrationError(
        "ACCOUNT_ALREADY_OWNED",
        "This external provider account is already registered to another tenant.",
      );
    }

    if (existing.externalAccountId !== input.externalAccountId) {
      throw new IntegrationRegistrationError(
        "ACCOUNT_IDENTITY_MISMATCH",
        "The external account key is already registered with a different external account ID.",
      );
    }

    // Do not overwrite existing credentials, metadata, or activation state.
    return {
      integrationId: existing.id,
      tenantId: existing.tenantId,
      systemName: existing.systemName,
      externalAccountId: existing.externalAccountId!,
      externalAccountKey: existing.externalAccountKey!,
      isActive: existing.isActive,
      created: false,
    };
  }
}

export const integrationRegistrationService =
  new IntegrationRegistrationService();
