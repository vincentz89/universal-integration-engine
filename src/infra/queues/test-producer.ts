import { dispatchSyncJob } from "./producer.js";
import { JOB_NAMES } from "./contracts/job-names.js";

// Basic producer test without tenant-specific business data.
async function main() {
  const result = await dispatchSyncJob(
    JOB_NAMES.TEST_CONNECTION,
    {
      message: "Hello from master-boilerplate",
    },
  );

  console.info("Test job dispatched:", result.job.id);
  console.info("Sync Log ID:", result.syncLogId);
}

main().catch((error) => {
  console.error("Producer failed:", error);
  process.exitCode = 1;
});