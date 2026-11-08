
import { z } from "zod";

import {
  testConnectionSchema,
  processWebhookEventSchema,
} from "./job-schemas.js";

import { JOB_NAMES } from "./job-names.js";

// Infer TypeScript contracts directly from Zod schemas.
export type TestConnectionJobDto = z.infer<
  typeof testConnectionSchema
>;

export type ProcessWebhookEventDto = z.infer<
  typeof processWebhookEventSchema
>;

// Maps each job name to its corresponding payload.
export interface JobPayloads {
  [JOB_NAMES.TEST_CONNECTION]: TestConnectionJobDto;

  [JOB_NAMES.PROCESS_WEBHOOK_EVENT]: ProcessWebhookEventDto;
}

export type JobPayload<T extends keyof JobPayloads> =
  JobPayloads[T];

// Internal queue envelope with idempotency ownership metadata.
export interface WebhookQueueData {
  syncLogId: string;
  idempotencyRecordId: string;
  leaseToken: string;
  payload: ProcessWebhookEventDto;
}

export interface TestQueueData {
  message: string;
}

export type QueueJobData =
  | WebhookQueueData
  | TestQueueData;
