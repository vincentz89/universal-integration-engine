import type { WebhookRecoveryAdapter } from "./recovery-adapter.types.js";

const adapters = new Map<string, WebhookRecoveryAdapter>();

function normalizeSource(source: string): string {
  const normalized = source.trim().toUpperCase();

  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)) {
    throw new Error(`Invalid recovery adapter source: ${source}`);
  }

  return normalized;
}

// Register one recovery adapter per integration provider.
export function registerRecoveryAdapter(
  adapter: WebhookRecoveryAdapter,
): void {
  const source = normalizeSource(adapter.source);

  if (adapters.has(source)) {
    throw new Error(`Recovery adapter already registered: ${source}`);
  }

  adapters.set(source, adapter);
}

// Resolve the adapter responsible for rebuilding a provider's webhook payload.
export function getRecoveryAdapter(
  source: string,
): WebhookRecoveryAdapter | undefined {
  return adapters.get(normalizeSource(source));
}

// Return all registered provider names for recovery query filtering.
export function getRegisteredRecoverySources(): string[] {
  return [...adapters.keys()];
}