import type { ProcessWebhookEventDto } from "../../contracts/job-types.js";
import type { WebhookRecoveryAdapter } from "../recovery-adapter.types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function extractResourceInformation(
  payload: Record<string, unknown>,
  eventType: string,
) {
  const data = isRecord(payload.data) ? payload.data : {};

  const resourceType =
    typeof data.type === "string"
      ? data.type
      : eventType.split("/")[1] ?? "unknown";

  const possibleIds = [
    data.id,
    data.product_id,
    data.variant_id,
    data.resource_id,
  ];

  const resourceId = possibleIds.find(
    (value) =>
      typeof value === "string" ||
      typeof value === "number",
  );

  return {
    resourceType,
    ...(resourceId !== undefined
      ? { resourceId: String(resourceId) }
      : {}),
  };
}

export const bigCommerceRecoveryAdapter: WebhookRecoveryAdapter = {
  source: "BIGCOMMERCE",

  buildPayload(input): ProcessWebhookEventDto {
    const resource = extractResourceInformation(
      input.payload,
      input.eventType,
    );

    return {
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      webhookEventId: input.webhookEventId,
      correlationId: input.correlationId,
      source: "BIGCOMMERCE",
      eventType: input.eventType,
      resourceType: resource.resourceType,
      ...(resource.resourceId !== undefined
        ? { resourceId: resource.resourceId }
        : {}),
      payload: input.payload,
    };
  },
};