
-- ==========================================
-- 1. CREATE ENUMS
-- ==========================================

CREATE TYPE "SyncLogStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCESS',
    'FAILED'
);

CREATE TYPE "WebhookStatus" AS ENUM (
    'RECEIVED',
    'PROCESSING',
    'PROCESSED',
    'FAILED'
);

-- ==========================================
-- 2. IDEMPOTENCY RECORD
-- ==========================================

-- Existing unique constraint on scope + idempotencyKey
-- already prevents duplicates before adding tenantKey.

DROP INDEX "IdempotencyRecord_scope_idempotencyKey_key";

ALTER TABLE "IdempotencyRecord"
ADD COLUMN "tenantKey" TEXT NOT NULL DEFAULT 'SYSTEM';

-- ==========================================
-- 3. SYNC LOG
-- ==========================================

-- Add new fields first.
-- updatedAt is temporarily nullable for backfilling.

ALTER TABLE "SyncLog"
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "correlationId" TEXT,
ADD COLUMN "durationMs" INTEGER,
ADD COLUMN "errorStack" TEXT,
ADD COLUMN "finishedAt" TIMESTAMP(3),
ADD COLUMN "metadata" JSONB,
ADD COLUMN "queueName" TEXT,
ADD COLUMN "source" TEXT,
ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "target" TEXT,
ADD COLUMN "tenantId" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3),
ADD COLUMN "webhookEventId" TEXT;

-- Remove old default if present before changing column type.

ALTER TABLE "SyncLog"
ALTER COLUMN "status" DROP DEFAULT;

-- Preserve existing SUCCESS and FAILED records.

ALTER TABLE "SyncLog"
ALTER COLUMN "status" TYPE "SyncLogStatus"
USING (
    CASE UPPER("status")
        WHEN 'SUCCESS' THEN 'SUCCESS'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'PENDING' THEN 'PENDING'
        WHEN 'PROCESSING' THEN 'PROCESSING'
        ELSE NULL
    END
)::"SyncLogStatus";

-- Restore the new enum default.

ALTER TABLE "SyncLog"
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Backfill existing timestamps.

UPDATE "SyncLog"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

-- Enforce NOT NULL after backfilling.

ALTER TABLE "SyncLog"
ALTER COLUMN "updatedAt" SET NOT NULL;

-- ==========================================
-- 4. WEBHOOK EVENTS
-- ==========================================

-- Existing WebhookEvent table contains zero records.
-- Therefore, tenantId can safely be required.

ALTER TABLE "WebhookEvent"
DROP COLUMN "isProcessed";

ALTER TABLE "WebhookEvent"
ADD COLUMN "correlationId" TEXT,
ADD COLUMN "errorMessage" TEXT,
ADD COLUMN "externalEventId" TEXT,
ADD COLUMN "processedAt" TIMESTAMP(3),
ADD COLUMN "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN "tenantId" TEXT NOT NULL;

-- ==========================================
-- 5. TENANT CONFIGURATION
-- ==========================================

CREATE TABLE "TenantConfig" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantConfig_pkey" PRIMARY KEY ("id")
);

-- ==========================================
-- 6. TENANT INTEGRATION CONFIGURATION
-- ==========================================

CREATE TABLE "TenantIntegrationConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "systemName" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "apiSecret" TEXT,
    "accessToken" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantIntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- ==========================================
-- 7. INDEXES
-- ==========================================

CREATE UNIQUE INDEX "TenantConfig_storeId_key"
ON "TenantConfig"("storeId");

CREATE INDEX "TenantConfig_isActive_idx"
ON "TenantConfig"("isActive");

CREATE INDEX "TenantIntegrationConfig_tenantId_isActive_idx"
ON "TenantIntegrationConfig"("tenantId", "isActive");

CREATE UNIQUE INDEX "TenantIntegrationConfig_tenantId_systemName_key"
ON "TenantIntegrationConfig"("tenantId", "systemName");

CREATE INDEX "IdempotencyRecord_tenantKey_status_createdAt_idx"
ON "IdempotencyRecord"("tenantKey", "status", "createdAt");

CREATE UNIQUE INDEX "IdempotencyRecord_tenantKey_scope_idempotencyKey_key"
ON "IdempotencyRecord"("tenantKey", "scope", "idempotencyKey");

CREATE INDEX "SyncLog_tenantId_createdAt_idx"
ON "SyncLog"("tenantId", "createdAt");

CREATE INDEX "SyncLog_tenantId_status_createdAt_idx"
ON "SyncLog"("tenantId", "status", "createdAt");

CREATE INDEX "SyncLog_tenantId_jobName_createdAt_idx"
ON "SyncLog"("tenantId", "jobName", "createdAt");

CREATE INDEX "SyncLog_jobId_idx"
ON "SyncLog"("jobId");

CREATE INDEX "SyncLog_correlationId_idx"
ON "SyncLog"("correlationId");

CREATE INDEX "SyncLog_status_createdAt_idx"
ON "SyncLog"("status", "createdAt");

CREATE INDEX "WebhookEvent_tenantId_createdAt_idx"
ON "WebhookEvent"("tenantId", "createdAt");

CREATE INDEX "WebhookEvent_tenantId_status_createdAt_idx"
ON "WebhookEvent"("tenantId", "status", "createdAt");

CREATE INDEX "WebhookEvent_correlationId_idx"
ON "WebhookEvent"("correlationId");

CREATE UNIQUE INDEX "WebhookEvent_tenantId_source_externalEventId_key"
ON "WebhookEvent"("tenantId", "source", "externalEventId");

-- ==========================================
-- 8. FOREIGN KEYS
-- ==========================================

ALTER TABLE "TenantIntegrationConfig"
ADD CONSTRAINT "TenantIntegrationConfig_tenantId_fkey"
FOREIGN KEY ("tenantId")
REFERENCES "TenantConfig"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "SyncLog"
ADD CONSTRAINT "SyncLog_tenantId_fkey"
FOREIGN KEY ("tenantId")
REFERENCES "TenantConfig"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "WebhookEvent"
ADD CONSTRAINT "WebhookEvent_tenantId_fkey"
FOREIGN KEY ("tenantId")
REFERENCES "TenantConfig"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
