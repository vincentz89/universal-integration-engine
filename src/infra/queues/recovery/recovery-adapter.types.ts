import type { ProcessWebhookEventDto } from "../contracts/job-types.js";

export interface WebhookRecoveryAdapter {
  source: string;

  buildPayload(input: {
    tenantId: string;
    integrationId: string;
    webhookEventId: string;
    correlationId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): ProcessWebhookEventDto;
}