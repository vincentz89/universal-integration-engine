
import { dispatchSyncJob } from "../src/infra/queues/producer.js";
import { JOB_NAMES } from "../src/infra/queues/contracts/job-names.js";

async function runTest() {
  try {
    console.log("[Test] Dispatching connection test job...");

    const result = await dispatchSyncJob(
      JOB_NAMES.TEST_CONNECTION,
      {
        message: "Hello from test-queues",
      },
    );

    console.log("[Test] Job dispatched successfully.");
    console.log("[Test] Job ID:", result.job.id);
    console.log("[Test] Sync Log ID:", result.syncLogId);
  } catch (error) {
    console.error("[Test] Queue dispatch failed:", error);
    process.exitCode = 1;
  }
}

runTest();
