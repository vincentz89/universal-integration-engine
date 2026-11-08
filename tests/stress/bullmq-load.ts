import { QueueEvents } from "bullmq";

import { dispatchSyncJob } from "../../src/infra/queues/producer.js";
import { redisConnection } from "../../src/infra/queues/redis.js";
import { JOB_NAMES } from "../../src/infra/queues/contracts/job-names.js";

const TOTAL_JOBS = 100;
const TIMEOUT_MS = 120_000;
const QUEUE_NAME = "integration-sync-queue";

async function runStressTest() {
  const queueEvents = new QueueEvents(QUEUE_NAME, {
    connection: redisConnection,
  });

  const expectedJobIds = new Set<string>();
  const completedJobIds = new Set<string>();
  const failedJobIds = new Set<string>();

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const checkCompletion = () => {
    if (expectedJobIds.size !== TOTAL_JOBS) {
      return;
    }

    const finishedCount = [...expectedJobIds].filter(
      (id) => completedJobIds.has(id) || failedJobIds.has(id),
    ).length;

    if (finishedCount === TOTAL_JOBS) {
      resolveCompletion();
    }
  };

  queueEvents.on("completed", ({ jobId }) => {
    completedJobIds.add(jobId);
    checkCompletion();
  });

  queueEvents.on("failed", ({ jobId, failedReason }) => {
    failedJobIds.add(jobId);

    console.error(`[Stress Test] Job failed: ${jobId}`);
    console.error(`[Stress Test] Reason: ${failedReason}`);

    checkCompletion();
  });

  queueEvents.on("error", (error) => {
    console.error("[Stress Test] QueueEvents error:", error);
    rejectCompletion(error);
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await queueEvents.waitUntilReady();

    console.log("=================================");
    console.log("BULLMQ STRESS TEST");
    console.log("=================================");
    console.log(`Total Jobs: ${TOTAL_JOBS}`);
    console.log("Worker Concurrency: 5");
    console.log("---------------------------------");

    const startTime = performance.now();

    // Dispatch 100 actual BullMQ jobs.
    await Promise.all(
      Array.from({ length: TOTAL_JOBS }, async (_, index) => {
        const result = await dispatchSyncJob(
          JOB_NAMES.TEST_CONNECTION,
          {
            message: `BullMQ stress test job ${index + 1}`,
          },
        );

        if (!result.job.id) {
          throw new Error("Dispatched job has no ID.");
        }

        expectedJobIds.add(String(result.job.id));
        checkCompletion();
      }),
    );

    console.log(`[Stress Test] Dispatched: ${expectedJobIds.size}`);

    // Wait until every dispatched job completes or fails.
    timeout = setTimeout(() => {
      rejectCompletion(
        new Error(`Timed out after ${TIMEOUT_MS / 1000} seconds.`),
      );
    }, TIMEOUT_MS);

    await completionPromise;

    const endTime = performance.now();
    const durationSeconds = (endTime - startTime) / 1000;

    const completed = [...expectedJobIds].filter(
      (id) => completedJobIds.has(id),
    ).length;

    const failed = [...expectedJobIds].filter(
      (id) => failedJobIds.has(id),
    ).length;

    const throughput = completed / durationSeconds;

    console.log("---------------------------------");
    console.log(`Total Jobs: ${TOTAL_JOBS}`);
    console.log(`Completed: ${completed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Duration: ${durationSeconds.toFixed(2)} seconds`);
    console.log(`Throughput: ${throughput.toFixed(2)} jobs/sec`);
    console.log("---------------------------------");

    if (completed === TOTAL_JOBS && failed === 0) {
      console.log("RESULT: PASSED");
    } else {
      console.log("RESULT: FAILED");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("[Stress Test] Test failed:", error);
    process.exitCode = 1;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }

    await queueEvents.close();
    await redisConnection.quit();
  }
}

runStressTest();