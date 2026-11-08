import "dotenv/config";

import { recoverExpiredWebhookJobs } from "../../src/infra/queues/recovery-dispatcher.js";
import { prisma } from "../../src/shared/utils/db.js";

async function main() {
  const tenantKey = process.argv[2];

  if (!tenantKey) {
    throw new Error("Missing tenantKey argument.");
  }

  try {
    // Signal that this independent process is ready.
    console.log("[Recovery Process] READY");

    // Wait until the parent process releases this worker.
    await new Promise<void>((resolve, reject) => {
      process.stdin.once("data", () => resolve());
      process.stdin.once("error", reject);
    });

    const result = await recoverExpiredWebhookJobs({
      tenantKey,
      limit: 10,
    });

    // Emit a machine-readable result for the parent test process.
    console.log(
      `MULTIPROCESS_RESULT=${JSON.stringify(result)}`,
    );
  } catch (error) {
    console.error("[Recovery Process] Failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();