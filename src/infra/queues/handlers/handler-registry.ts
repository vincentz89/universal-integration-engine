import type {
  ProcessWebhookEventDto,
} from "../contracts/job-types.js";

// Each entity handler receives the same generic webhook contract.
export type WebhookHandler = (
  event: ProcessWebhookEventDto,
) => Promise<unknown>;

// Registry key format: SOURCE:RESOURCE_TYPE
const handlers = new Map<string, WebhookHandler>();

function getHandlerKey(source: string, resourceType: string) {
  return `${source.toUpperCase()}:${resourceType.toLowerCase()}`;
}

// Register entity-specific handlers without modifying the worker.
export function registerWebhookHandler(
  source: string,
  resourceType: string,
  handler: WebhookHandler,
) {
  const key = getHandlerKey(source, resourceType);

  if (handlers.has(key)) {
    throw new Error(`Handler already registered: ${key}`);
  }

  handlers.set(key, handler);
}

// Resolve and execute the appropriate business handler.
export async function executeWebhookHandler(
  event: ProcessWebhookEventDto,
) {
  const key = getHandlerKey(
    event.source,
    event.resourceType,
  );

  const handler = handlers.get(key);

  if (!handler) {
    throw new Error(
      `No webhook handler registered for ${key}`,
    );
  }

  return handler(event);
}