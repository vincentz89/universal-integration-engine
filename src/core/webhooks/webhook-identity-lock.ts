import type { Prisma } from "@prisma/client";

export interface WebhookIdentityLockInput {
  tenantId: string;
  provider: string;
  externalEventId: string;
}

/**
 * Acquires a transaction-scoped PostgreSQL advisory lock
 * for a webhook identity.
 *
 * The lock intentionally excludes integrationId so legacy
 * and integration-linked webhook events coordinate using
 * the same ownership key.
 *
 * The lock is automatically released when the transaction
 * commits or rolls back.
 */
export async function acquireWebhookIdentityLock(
  tx: Prisma.TransactionClient,
  input: WebhookIdentityLockInput,
): Promise<void> {
  const { tenantId, provider, externalEventId } = input;

  if (!tenantId.trim()) {
    throw new Error("Webhook identity lock requires a tenantId.");
  }

  if (!provider.trim()) {
    throw new Error("Webhook identity lock requires a provider.");
  }

  if (!externalEventId.trim()) {
    throw new Error(
      "Webhook identity lock requires an externalEventId.",
    );
  }

  const lockIdentity = JSON.stringify([
    tenantId,
    provider,
    externalEventId,
  ]);

    await tx.$queryRaw`
      WITH acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${lockIdentity}, 0)
        )
      )
      SELECT 1::int AS lock_acquired
      FROM acquired
    `;
}