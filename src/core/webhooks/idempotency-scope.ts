
/**
 * Legacy BigCommerce scope.
 *
 * Existing idempotency records and queued jobs use this value.
 * Never remove it while legacy records may still exist.
 */
export const LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE =
  "BIGCOMMERCE_WEBHOOK";

/**
 * Validates a canonical integration system name.
 */
function validateSystemName(systemName: string): string {
  if (
    typeof systemName !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(systemName)
  ) {
    throw new Error(
      "Invalid integration system name for webhook idempotency scope.",
    );
  }

  return systemName;
}

/**
 * Validates an integration ID before including it in a scope.
 *
 * The maximum length keeps the generated scope within
 * the database column limit of 150 characters.
 */
function validateIntegrationId(integrationId: string): string {
  if (
    typeof integrationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,60}$/.test(integrationId)
  ) {
    throw new Error(
      "Invalid integration ID for webhook idempotency scope.",
    );
  }

  return integrationId;
}

/**
 * Returns the legacy provider-level scope.
 *
 * Retained for backward compatibility with existing records.
 */
export function getWebhookIdempotencyScope(
  verifiedSystemName: string,
): string {
  const systemName = validateSystemName(verifiedSystemName);

  if (systemName === "BIGCOMMERCE") {
    return LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE;
  }

  return `WEBHOOK:${systemName}`;
}

/**
 * Returns the account-specific scope for new webhook records.
 *
 * Call only after verifying that the integration belongs
 * to the specified tenant and provider.
 */
export function getIntegrationWebhookIdempotencyScope(
  verifiedSystemName: string,
  verifiedIntegrationId: string,
): string {
  const systemName = validateSystemName(verifiedSystemName);
  const integrationId = validateIntegrationId(
    verifiedIntegrationId,
  );

  return `WEBHOOK:${systemName}:INTEGRATION:${integrationId}`;
}

/**
 * Resolves a webhook scope to its canonical provider name.
 *
 * Supports:
 * - Legacy BigCommerce scopes
 * - Legacy provider-level scopes
 * - New account-specific scopes
 */
export function getWebhookSystemNameFromScope(
  scope: string,
): string | null {
  if (typeof scope !== "string") {
    return null;
  }

  if (scope === LEGACY_BIGCOMMERCE_WEBHOOK_SCOPE) {
    return "BIGCOMMERCE";
  }

  const prefix = "WEBHOOK:";

  if (!scope.startsWith(prefix)) {
    return null;
  }

  const remainder = scope.slice(prefix.length);
  const integrationMarker = ":INTEGRATION:";
  const markerIndex = remainder.indexOf(integrationMarker);

  const systemName =
    markerIndex === -1
      ? remainder
      : remainder.slice(0, markerIndex);

  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(systemName)) {
    return null;
  }

  if (markerIndex !== -1) {
    const integrationId = remainder.slice(
      markerIndex + integrationMarker.length,
    );

    if (!/^[A-Za-z0-9_-]{1,60}$/.test(integrationId)) {
      return null;
    }
  }

  return systemName;
}

/**
 * Extracts the integration ID from an account-specific scope.
 *
 * Returns null for legacy provider-level scopes.
 */
export function getWebhookIntegrationIdFromScope(
  scope: string,
): string | null {
  if (typeof scope !== "string") {
    return null;
  }

  const prefix = "WEBHOOK:";
  const integrationMarker = ":INTEGRATION:";

  if (!scope.startsWith(prefix)) {
    return null;
  }

  const markerIndex = scope.indexOf(integrationMarker);

  if (markerIndex === -1) {
    return null;
  }

  const integrationId = scope.slice(
    markerIndex + integrationMarker.length,
  );

  if (!/^[A-Za-z0-9_-]{1,60}$/.test(integrationId)) {
    return null;
  }

  const systemName = scope.slice(
    prefix.length,
    markerIndex,
  );

  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(systemName)) {
    return null;
  }

  return integrationId;
}
