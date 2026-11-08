import { performance } from "node:perf_hooks";

// Define the workload for the initial stress test.
const TOTAL_JOBS = 100;
const CONCURRENCY = 5;

interface TestJob {
  id: number;
  message: string;
}

async function simulateJob(job: TestJob): Promise<TestJob> {
  // Simulate a small amount of processing time.
  await new Promise((resolve) => setTimeout(resolve, 100));

  return job;
}

async function runStressTest() {
  console.log("=================================");
  console.log("QUEUE STRESS TEST");
  console.log("=================================");

  const jobs: TestJob[] = Array.from(
    { length: TOTAL_JOBS },
    (_, index) => ({
      id: index + 1,
      message: `Test Job ${index + 1}`,
    })
  );

  let completed = 0;
  let failed = 0;

  const startTime = performance.now();

  // Process jobs using a controlled concurrency limit.
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((job) => simulateJob(job))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        completed++;
      } else {
        failed++;
      }
    }
  }

  const endTime = performance.now();
  const durationSeconds = (endTime - startTime) / 1000;

  console.log("---------------------------------");
  console.log(`Total Jobs: ${TOTAL_JOBS}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Duration: ${durationSeconds.toFixed(2)} seconds`);
  console.log(
    `Throughput: ${(completed / durationSeconds).toFixed(2)} jobs/sec`
  );
  console.log("---------------------------------");

  if (completed === TOTAL_JOBS && failed === 0) {
    console.log("RESULT: PASSED");
  } else {
    console.log("RESULT: FAILED");
    process.exitCode = 1;
  }
}

runStressTest().catch((error) => {
  console.error("Stress test failed:", error);
  process.exitCode = 1;
});