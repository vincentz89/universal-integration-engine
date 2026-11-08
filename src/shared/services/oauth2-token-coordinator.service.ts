
import { prisma } from "../utils/db.js";
import { encryptCredential } from "../security/credential-encryption.js";

import {
  tenantCredentialService,
} from "./tenant-credential.service.js";

import {
  oauth2RefreshLockRepository,
} from "../repositories/oauth2-refresh-lock.repository.js";

import {
  oauth2TokenRepository,
} from "../repositories/oauth2-token.repository.js";

import {
  refreshOAuth2AccessToken,
} from "../../infra/connectors/auth/oauth2-token.client.js";

type OAuth2TokenRefresher = typeof refreshOAuth2AccessToken;

import type {
  OAuth2Credentials,
} from "../../infra/connectors/auth/auth.types.js";

import type {
  OAuth2TokenEndpointConfigInput,
} from "../../infra/connectors/auth/oauth2.config.js";

export interface GetOAuth2AccessTokenInput {
  tenantId: string;
  integrationId: string;
  expectedSystemName: string;

  // Application-controlled provider configuration.
  tokenEndpointConfig: OAuth2TokenEndpointConfigInput;
  allowedTokenHosts: readonly string[];

  validityBufferMs?: number;
  lockDurationMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface OAuth2AccessTokenResult {
  accessToken: string;
  expiresAt: Date | null;
}

const DEFAULT_VALIDITY_BUFFER_MS = 60_000;
const DEFAULT_LOCK_DURATION_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 65_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function validateOptions(input: GetOAuth2AccessTokenInput): void {
  if (!input.tenantId.trim()) {
    throw new Error("Tenant ID is required.");
  }

  if (!input.integrationId.trim()) {
    throw new Error("Integration ID is required.");
  }

  if (!input.expectedSystemName.trim()) {
    throw new Error("Expected system name is required.");
  }

  if (input.allowedTokenHosts.length === 0) {
    throw new Error("OAuth2 trusted token hosts are required.");
  }

  const validityBuffer =
    input.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;

  const lockDuration =
    input.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;

  const waitTimeout =
    input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  const pollInterval =
    input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (
    !Number.isSafeInteger(validityBuffer) ||
    validityBuffer < 0 ||
    validityBuffer > 300_000
  ) {
    throw new Error("Invalid OAuth2 token validity buffer.");
  }

  if (
    !Number.isSafeInteger(lockDuration) ||
    lockDuration < 1_000 ||
    lockDuration > 300_000
  ) {
    throw new Error("Invalid OAuth2 refresh lock duration.");
  }

  if (
    !Number.isSafeInteger(waitTimeout) ||
    waitTimeout < 1_000 ||
    waitTimeout > 120_000
  ) {
    throw new Error("Invalid OAuth2 refresh wait timeout.");
  }

  if (
    !Number.isSafeInteger(pollInterval) ||
    pollInterval < 50 ||
    pollInterval > 5_000
  ) {
    throw new Error("Invalid OAuth2 polling interval.");
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class OAuth2TokenCoordinatorService {
  constructor(
    private readonly refreshToken: OAuth2TokenRefresher =
      refreshOAuth2AccessToken,
  ) {}
  /**
   * Returns a valid access token or coordinates a distributed refresh.
   *
   * Only the current refresh-lock owner can persist replacement tokens.
   */
  async getAccessToken(
    input: GetOAuth2AccessTokenInput,
  ): Promise<OAuth2AccessTokenResult> {
    validateOptions(input);

    const validityBuffer =
      input.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;

    const lockDuration =
      input.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;

    const waitTimeout =
      input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

    const pollInterval =
      input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const deadline = Date.now() + waitTimeout;

    while (Date.now() < deadline) {
      const integration = await prisma.tenantIntegrationConfig.findFirst({
        where: {
          id: input.integrationId,
          tenantId: input.tenantId,
          systemName: input.expectedSystemName,
          isActive: true,
          authType: "OAUTH2",
        },
        select: {
          accessTokenExpiresAt: true,
        },
      });

      if (!integration) {
        throw new Error(
          "Active OAuth2 integration not found for tenant.",
        );
      }

      // Read the current credentials and return immediately if the
      // existing access token remains valid beyond the safety buffer.
      const currentCredentials =
        await tenantCredentialService.getIntegrationCredentials(
          input.tenantId,
          input.integrationId,
          input.expectedSystemName,
        );

      if (currentCredentials.authType !== "OAUTH2") {
        throw new Error("Integration must use OAuth2 authentication.");
      }

      const currentAccessToken =
        currentCredentials.credentials.accessToken;

      const currentExpiry = integration.accessTokenExpiresAt;

      if (
        typeof currentAccessToken === "string" &&
        currentAccessToken.trim().length > 0 &&
        currentExpiry !== null &&
        currentExpiry.getTime() > Date.now() + validityBuffer
      ) {
        return {
          accessToken: currentAccessToken,
          expiresAt: currentExpiry,
        };
      }

      // Try to become the single worker responsible for refreshing.
      const lock = await oauth2RefreshLockRepository.acquire({
        tenantId: input.tenantId,
        integrationId: input.integrationId,
        lockDurationMs: lockDuration,
      });

      if (!lock) {
        // Another worker owns the lock. Recheck the token after a short
        // delay; if the owner fails, this worker can acquire the lock.
        await sleep(pollInterval);
        continue;
      }

      let persisted = false;

      try {
        // Re-read after acquiring the lock. Another worker may have
        // completed a refresh just before this worker acquired it.
        const latestIntegration =
          await prisma.tenantIntegrationConfig.findFirst({
            where: {
              id: input.integrationId,
              tenantId: input.tenantId,
              systemName: input.expectedSystemName,
              isActive: true,
              authType: "OAUTH2",
              tokenRefreshLockToken: lock.lockToken,
            },
            select: {
              accessTokenExpiresAt: true,
            },
          });

        if (!latestIntegration) {
          throw new Error(
            "OAuth2 refresh lock ownership was lost.",
          );
        }

        const latestCredentials =
          await tenantCredentialService.getIntegrationCredentials(
            input.tenantId,
            input.integrationId,
            input.expectedSystemName,
          );

        const latestAccessToken =
          latestCredentials.credentials.accessToken;

        const latestExpiry =
          latestIntegration.accessTokenExpiresAt;

        if (
          typeof latestAccessToken === "string" &&
          latestAccessToken.trim().length > 0 &&
          latestExpiry !== null &&
          latestExpiry.getTime() > Date.now() + validityBuffer
        ) {
          return {
            accessToken: latestAccessToken,
            expiresAt: latestExpiry,
          };
        }

        const credentials = {
          clientId: latestCredentials.credentials.clientId,
          clientSecret: latestCredentials.credentials.clientSecret,
          refreshToken: latestCredentials.credentials.refreshToken,
          accessToken: latestAccessToken,
        } as OAuth2Credentials;

        // Maintain ownership of the distributed refresh lock while
        // the provider request is running.
        let heartbeatFailure: Error | null = null;
        let heartbeatInFlight: Promise<void> | null = null;

        const heartbeatIntervalMs = Math.max(
          250,
          Math.floor(lockDuration / 3),
        );

        const refreshed = await (async () => {
          const heartbeatTimer = setInterval(() => {
            // Prevent overlapping renewal requests.
            if (
              heartbeatInFlight !== null ||
              heartbeatFailure !== null
            ) {
              return;
            }

            heartbeatInFlight = (async () => {
              try {
                const renewed = await oauth2RefreshLockRepository.renew(
                  lock,
                  lockDuration,
                );

                if (!renewed) {
                  heartbeatFailure = new Error(
                    "OAuth2 refresh lock ownership was lost during token refresh.",
                  );
                }
              } catch {
                heartbeatFailure = new Error(
                  "OAuth2 refresh lock renewal failed.",
                );
              } finally {
                heartbeatInFlight = null;
              }
            })();
          }, heartbeatIntervalMs);

          try {
            return await this.refreshToken({
              config: input.tokenEndpointConfig,
              credentials,
              allowedTokenHosts: input.allowedTokenHosts,
            });
          } finally {
            // Stop future renewals when the provider request finishes.
            clearInterval(heartbeatTimer);

            // Wait for any ongoing renewal before checking its result.
            if (heartbeatInFlight !== null) {
              await heartbeatInFlight;
            }
          }
        })();

        // Never persist credentials if the heartbeat failed or
        // another worker took ownership of the refresh lock.
        if (heartbeatFailure !== null) {
          throw heartbeatFailure;
        }

        // Some OAuth2 providers rotate refresh tokens; others do not.
        // Preserve the existing refresh token when no replacement is sent.
        const updatedCredentials = {
          ...latestCredentials.credentials,
          accessToken: refreshed.access_token,
          refreshToken:
            refreshed.refresh_token ??
            latestCredentials.credentials.refreshToken,
        };

        const encryptedCredentials = encryptCredential(
          JSON.stringify(updatedCredentials),
        );

        const expiresAt =
          typeof refreshed.expires_in === "number"
            ? new Date(Date.now() + refreshed.expires_in * 1_000)
            : null;

        // The repository verifies lock ownership and releases the lock
        // atomically with the credential and expiry update.
        const saved =
          await oauth2TokenRepository.persistRefreshedTokens({
            tenantId: input.tenantId,
            integrationId: input.integrationId,
            lockToken: lock.lockToken,
            credentialsEncrypted: encryptedCredentials,
            tokenType: refreshed.token_type ?? "Bearer",
            accessTokenExpiresAt: expiresAt,
          });

        if (!saved) {
          throw new Error(
            "OAuth2 refresh lock ownership was lost before token persistence.",
          );
        }

        persisted = true;

        return {
          accessToken: refreshed.access_token,
          expiresAt,
        };
      } finally {
        // On failure, release only this worker's lock.
        // Successful persistence already released it atomically.
        if (!persisted) {
          await oauth2RefreshLockRepository.release(lock);
        }
      }
    }

    throw new Error(
      "Timed out waiting for OAuth2 access token refresh.",
    );
  }
}

export const oauth2TokenCoordinatorService =
  new OAuth2TokenCoordinatorService();
