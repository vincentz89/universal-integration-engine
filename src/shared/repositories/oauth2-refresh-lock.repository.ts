
import { randomUUID } from "node:crypto";

import { prisma } from "../utils/db.js";

export interface AcquireOAuth2RefreshLockInput {
  tenantId: string;
  integrationId: string;
  lockDurationMs?: number;
}

export interface OAuth2RefreshLock {
  tenantId: string;
  integrationId: string;
  lockToken: string;
  expiresAt: Date;
}

const DEFAULT_LOCK_DURATION_MS = 60_000;
const MAX_LOCK_DURATION_MS = 300_000;

function validateInput(
  input: AcquireOAuth2RefreshLockInput,
): number {
  if (!input.tenantId.trim()) {
    throw new Error("Tenant ID is required.");
  }

  if (!input.integrationId.trim()) {
    throw new Error("Integration ID is required.");
  }

  const duration =
    input.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;

  if (
    !Number.isSafeInteger(duration) ||
    duration < 1_000 ||
    duration > MAX_LOCK_DURATION_MS
  ) {
    throw new Error("Invalid OAuth2 refresh lock duration.");
  }

  return duration;
}

export class OAuth2RefreshLockRepository {
  /**
   * Atomically acquires an expired or unowned refresh lock.
   *
   * Only one worker can acquire the lock for a given integration.
   */
  async acquire(
    input: AcquireOAuth2RefreshLockInput,
  ): Promise<OAuth2RefreshLock | null> {
    const duration = validateInput(input);
    const lockToken = randomUUID();
    const expiresAt = new Date(Date.now() + duration);

    const result = await prisma.tenantIntegrationConfig.updateMany({
      where: {
        id: input.integrationId,
        tenantId: input.tenantId,
        isActive: true,
        authType: "OAUTH2",
        OR: [
          { tokenRefreshLockToken: null },
          {
            tokenRefreshLockExpiresAt: {
              lte: new Date(),
            },
          },
        ],
      },
      data: {
        tokenRefreshLockToken: lockToken,
        tokenRefreshLockExpiresAt: expiresAt,
      },
    });

    if (result.count !== 1) {
      return null;
    }

    return {
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      lockToken,
      expiresAt,
    };
  }

  /**
   * Renews a lock only while the caller still owns an unexpired lock.
   */
  async renew(
    lock: OAuth2RefreshLock,
    lockDurationMs = DEFAULT_LOCK_DURATION_MS,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(lockDurationMs) ||
      lockDurationMs < 1_000 ||
      lockDurationMs > MAX_LOCK_DURATION_MS
    ) {
      throw new Error("Invalid OAuth2 refresh lock duration.");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + lockDurationMs);

    const result = await prisma.tenantIntegrationConfig.updateMany({
      where: {
        id: lock.integrationId,
        tenantId: lock.tenantId,
        isActive: true,
        authType: "OAUTH2",
        tokenRefreshLockToken: lock.lockToken,
        tokenRefreshLockExpiresAt: {
          gt: now,
        },
      },
      data: {
        tokenRefreshLockExpiresAt: expiresAt,
      },
    });

    if (result.count !== 1) {
      return false;
    }

    lock.expiresAt = expiresAt;

    return true;
  }

  /**
   * Releases a lock only when the caller still owns it.
   */
  async release(lock: OAuth2RefreshLock): Promise<boolean> {
    const result = await prisma.tenantIntegrationConfig.updateMany({
      where: {
        id: lock.integrationId,
        tenantId: lock.tenantId,
        tokenRefreshLockToken: lock.lockToken,
      },
      data: {
        tokenRefreshLockToken: null,
        tokenRefreshLockExpiresAt: null,
      },
    });

    return result.count === 1;
  }
}

export const oauth2RefreshLockRepository =
  new OAuth2RefreshLockRepository();
