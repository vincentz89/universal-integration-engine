
import { prisma } from "../utils/db.js";

export interface PersistOAuth2TokensInput {
  tenantId: string;
  integrationId: string;
  lockToken: string;
  credentialsEncrypted: string;
  tokenType: string;
  accessTokenExpiresAt: Date | null;
}

export class OAuth2TokenRepository {
  /**
   * Persists refreshed OAuth2 credentials only while the caller
   * owns an active refresh lock.
   *
   * The token update and lock release happen in one database operation.
   */
  async persistRefreshedTokens(
    input: PersistOAuth2TokensInput,
  ): Promise<boolean> {
    if (!input.tenantId.trim()) {
      throw new Error("Tenant ID is required.");
    }

    if (!input.integrationId.trim()) {
      throw new Error("Integration ID is required.");
    }

    if (!input.lockToken.trim()) {
      throw new Error("Refresh lock token is required.");
    }

    if (!input.credentialsEncrypted.trim()) {
      throw new Error("Encrypted credentials are required.");
    }

    if (input.tokenType.toLowerCase() !== "bearer") {
      throw new Error("Unsupported OAuth2 token type.");
    }

    if (
      input.accessTokenExpiresAt !== null &&
      Number.isNaN(input.accessTokenExpiresAt.getTime())
    ) {
      throw new Error("Invalid OAuth2 token expiration date.");
    }

    const now = new Date();

    const result = await prisma.tenantIntegrationConfig.updateMany({
      where: {
        id: input.integrationId,
        tenantId: input.tenantId,
        isActive: true,
        authType: "OAUTH2",
        tokenRefreshLockToken: input.lockToken,
        tokenRefreshLockExpiresAt: {
          gt: now,
        },
      },
      data: {
        credentialsEncrypted: input.credentialsEncrypted,
        tokenType: input.tokenType,
        accessTokenExpiresAt: input.accessTokenExpiresAt,

        // Release the lock as part of the successful token update.
        tokenRefreshLockToken: null,
        tokenRefreshLockExpiresAt: null,
      },
    });

    return result.count === 1;
  }
}

export const oauth2TokenRepository = new OAuth2TokenRepository();
