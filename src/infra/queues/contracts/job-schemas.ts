import { z } from "zod";

export const processWebhookEventSchema = z.object({
  tenantId: z.uuid(),
  integrationId: z.uuid(),
  webhookEventId: z.uuid(),
  correlationId: z.uuid(),
  source: z.string().min(1),
  eventType: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

// Complete BullMQ webhook job envelope.
export const webhookQueueDataSchema = z.object({
  syncLogId: z.uuid(),
  idempotencyRecordId: z.uuid(),
  leaseToken: z.uuid(),
  payload: processWebhookEventSchema,
});

export const testConnectionSchema = z.object({
  message: z.string().min(1),
});

export const jobSchemas = {
  TEST_CONNECTION: testConnectionSchema,
  PROCESS_WEBHOOK_EVENT: processWebhookEventSchema,
} as const;