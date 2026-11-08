BEGIN;

-- Remove the old global uniqueness rule.
DROP INDEX "WebhookEvent_tenantId_source_externalEventId_key";

-- Enforce uniqueness for integration-owned webhook events.
CREATE UNIQUE INDEX "WebhookEvent_integration_event_unique"
ON "WebhookEvent" (
    "tenantId",
    "source",
    "integrationId",
    "externalEventId"
)
WHERE
    "integrationId" IS NOT NULL
    AND "externalEventId" IS NOT NULL;

-- Preserve uniqueness for legacy events without integration ownership.
CREATE UNIQUE INDEX "WebhookEvent_legacy_event_unique"
ON "WebhookEvent" (
    "tenantId",
    "source",
    "externalEventId"
)
WHERE
    "integrationId" IS NULL
    AND "externalEventId" IS NOT NULL;

COMMIT;
