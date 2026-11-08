-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN     "recoveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recoveryLastError" TEXT,
ADD COLUMN     "recoveryNextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_status_jobName_recoveryNextAttemptAt_leas_idx" ON "IdempotencyRecord"("status", "jobName", "recoveryNextAttemptAt", "leaseExpiresAt");
