/*
  Warnings:

  - You are about to drop the column `accessToken` on the `TenantIntegrationConfig` table. All the data in the column will be lost.
  - You are about to drop the column `apiKey` on the `TenantIntegrationConfig` table. All the data in the column will be lost.
  - You are about to drop the column `apiSecret` on the `TenantIntegrationConfig` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `TenantIntegrationConfig` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "IntegrationAuthType" AS ENUM ('NONE', 'API_KEY', 'BASIC', 'BEARER', 'OAUTH2');

-- AlterTable
ALTER TABLE "TenantIntegrationConfig" DROP COLUMN "accessToken",
DROP COLUMN "apiKey",
DROP COLUMN "apiSecret",
DROP COLUMN "metadata",
ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "authConfig" JSONB,
ADD COLUMN     "authType" "IntegrationAuthType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "credentialsEncrypted" TEXT,
ADD COLUMN     "tokenRefreshLockExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tokenRefreshLockToken" TEXT,
ADD COLUMN     "tokenType" TEXT;

-- CreateIndex
CREATE INDEX "TenantIntegrationConfig_tokenRefreshLockExpiresAt_idx" ON "TenantIntegrationConfig"("tokenRefreshLockExpiresAt");
