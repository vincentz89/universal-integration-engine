BEGIN;

-- ==========================================
-- 1. CREATE LEGACY TENANT REFERENCE TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS "TenantLegacyReference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceValue" TEXT NOT NULL,
    "sourceSystem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantLegacyReference_pkey"
        PRIMARY KEY ("id")
);

CREATE INDEX "TenantLegacyReference_tenantId_idx"
ON "TenantLegacyReference"("tenantId");

CREATE INDEX "TenantLegacyReference_sourceSystem_idx"
ON "TenantLegacyReference"("sourceSystem");

CREATE UNIQUE INDEX
"TenantLegacyReference_tenantId_referenceType_referenceValue_key"
ON "TenantLegacyReference"(
    "tenantId",
    "referenceType",
    "referenceValue"
);

ALTER TABLE "TenantLegacyReference"
ADD CONSTRAINT "TenantLegacyReference_tenantId_fkey"
FOREIGN KEY ("tenantId")
REFERENCES "TenantConfig"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;


-- ==========================================
-- 2. ADD EXTERNAL ACCOUNT IDENTITY
-- ==========================================

ALTER TABLE "TenantIntegrationConfig"
ADD COLUMN "externalAccountId" TEXT,
ADD COLUMN "externalAccountKey" TEXT,
ADD COLUMN "externalAccountMetadata" JSONB;

DROP INDEX "TenantIntegrationConfig_tenantId_systemName_key";
DROP INDEX "TenantIntegrationConfig_tenantId_isActive_idx";

CREATE INDEX
"TenantIntegrationConfig_tenantId_systemName_isActive_idx"
ON "TenantIntegrationConfig"(
    "tenantId",
    "systemName",
    "isActive"
);

CREATE UNIQUE INDEX
"TenantIntegrationConfig_systemName_externalAccountKey_key"
ON "TenantIntegrationConfig"(
    "systemName",
    "externalAccountKey"
);

CREATE UNIQUE INDEX
"TenantIntegrationConfig_id_tenantId_key"
ON "TenantIntegrationConfig"("id", "tenantId");


-- ==========================================
-- 3. ADD WEBHOOK INTEGRATION ASSOCIATION
-- ==========================================

ALTER TABLE "WebhookEvent"
ADD COLUMN "integrationId" TEXT;

-- Map historical events only when exactly one integration
-- matches both the tenant and provider.
WITH unique_matches AS (
    SELECT
        webhook."id" AS webhook_id,
        MIN(integration."id") AS integration_id
    FROM "WebhookEvent" webhook
    INNER JOIN "TenantIntegrationConfig" integration
        ON integration."tenantId" = webhook."tenantId"
        AND integration."systemName" = webhook."source"
    GROUP BY webhook."id"
    HAVING COUNT(integration."id") = 1
)
UPDATE "WebhookEvent" webhook
SET "integrationId" = matches.integration_id
FROM unique_matches matches
WHERE webhook."id" = matches.webhook_id;

-- Ensure the integration belongs to the same tenant.
-- NULL integrationId is permitted for events without a safe match.
ALTER TABLE "WebhookEvent"
ADD CONSTRAINT "WebhookEvent_integrationId_tenantId_fkey"
FOREIGN KEY ("integrationId", "tenantId")
REFERENCES "TenantIntegrationConfig"("id", "tenantId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

COMMIT;