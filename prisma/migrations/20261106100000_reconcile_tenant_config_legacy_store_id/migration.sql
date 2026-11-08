-- Reconcile migration history with the existing TenantConfig schema.
-- The legacy storeId column and its unique index are already absent
-- from the current database. IF EXISTS keeps this safe in either state.

DROP INDEX IF EXISTS "TenantConfig_storeId_key";

ALTER TABLE "TenantConfig"
DROP COLUMN IF EXISTS "storeId";