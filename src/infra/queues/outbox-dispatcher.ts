
import type { OutboxEvent } from "@prisma/client";

import { integrationQueue } from "./queue.js";
import { JOB_NAMES } from "./contracts/job-names.js";
import { webhookQueueDataSchema } from "./contracts/job-schemas.js";

import {
  outboxRepository,
  OUTBOX_BATCH_SIZE,
} from "../../shared/repositories/outbox.repository.js";

// ==========================================
// TYPES
// ==========================================

interface OutboxDispatchPayload {
  jobName: string;
  jobData: unknown;
}

interface DispatchResult {
  published: number;
  failed: number;
  skipped: number;
}

// ==========================================
// HELPERS
// ==========================================

function parseOutboxPayload(
  payload: OutboxEvent["payload"],
): OutboxDispatchPayload | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const data = payload as Record<string, unknown>;

  if (
    typeof data.jobName !== "string" ||
    !("jobData" in data)
  ) {
    return null;
  }

  return {
    jobName: data.jobName,
    jobData: data.jobData,
  };
}

// ==========================================
// DISPATCH SINGLE EVENT
// ==========================================

export async function dispatchOutboxEvent(
  event: OutboxEvent,
): Promise<"PUBLISHED" | "FAILED" | "SKIPPED"> {
  const lockToken = event.lockToken;

  if (!lockToken) {
    console.warn("[Outbox] Missing lock token:", event.id);
    return "SKIPPED";
  }

  try {
    const payload = parseOutboxPayload(event.payload);

    if (!payload) {
      throw new Error("Invalid Outbox payload structure.");
    }

    // This first implementation supports webhook jobs only.
    if (payload.jobName !== JOB_NAMES.PROCESS_WEBHOOK_EVENT) {
      throw new Error(
        `Unsupported Outbox job: ${payload.jobName}`,
      );
    }

    // Validate the complete queue envelope.
    const parsedQueueData = webhookQueueDataSchema.safeParse(
      payload.jobData,
    );

    if (!parsedQueueData.success) {
      throw new Error(
        `Invalid webhook queue payload: ${parsedQueueData.error.message}`,
      );
    }

    // Deterministic job ID reduces duplicate queue insertion
    // if the dispatcher crashes after Redis accepts the job.
    const jobId = `outbox_${event.id}`;

    // Publish only the validated queue data.
    await integrationQueue.add(
      JOB_NAMES.PROCESS_WEBHOOK_EVENT,
      parsedQueueData.data,
      {
        jobId,
      },
    );

    // Finalize only if this dispatcher still owns the Outbox event.
    const marked = await outboxRepository.markPublished(
      event.id,
      lockToken,
    );

    if (!marked) {
      console.warn(
        "[Outbox] Job published, but ownership was lost before finalization:",
        event.id,
      );

      return "SKIPPED";
    }

    console.info("[Outbox] Published:", {
      outboxId: event.id,
      jobId,
      attempt: event.attemptCount,
    });

    return "PUBLISHED";
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error));

    try {
      const marked = await outboxRepository.markFailed(
        event,
        lockToken,
        normalizedError,
      );

      console.error("[Outbox] Publishing failed:", {
        outboxId: event.id,
        attempt: event.attemptCount,
        error: normalizedError.message,
        retryScheduled: marked,
      });

      return marked ? "FAILED" : "SKIPPED";
    } catch (finalizationError) {
      console.error(
        "[Outbox] Could not record publishing failure:",
        {
          outboxId: event.id,
          originalError: normalizedError.message,
          finalizationError,
        },
      );

      return "SKIPPED";
    }
  }
}

// ==========================================
// DISPATCH CYCLE
// ==========================================

export async function runOutboxDispatchCycle(): Promise<DispatchResult> {
  const events = await outboxRepository.claimPending({
    limit: OUTBOX_BATCH_SIZE,
  });

  const results = await Promise.all(
    events.map(dispatchOutboxEvent),
  );

  const summary: DispatchResult = {
    published: results.filter(
      (result) => result === "PUBLISHED",
    ).length,

    failed: results.filter(
      (result) => result === "FAILED",
    ).length,

    skipped: results.filter(
      (result) => result === "SKIPPED",
    ).length,
  };

  if (events.length > 0) {
    console.info("[Outbox] Dispatch cycle completed:", {
      scanned: events.length,
      ...summary,
    });
  }

  return summary;
}
