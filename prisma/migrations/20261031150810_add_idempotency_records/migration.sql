-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(150) NOT NULL,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "jobName" TEXT NOT NULL,
    "jobId" TEXT,
    "requestHash" VARCHAR(64),
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "result" JSONB,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_status_leaseExpiresAt_idx" ON "IdempotencyRecord"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_jobId_idx" ON "IdempotencyRecord"("jobId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_idempotencyKey_key" ON "IdempotencyRecord"("scope", "idempotencyKey");
