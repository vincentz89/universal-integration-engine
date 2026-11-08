import "dotenv/config";
import { prisma } from "../../src/shared/utils/db.js";

const recordId = "3082d08e-a39e-4743-a7e7-86d52e89f213";

async function inspect() {
  try {
    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { id: recordId },
    });

    const event = await prisma.webhookEvent.findFirst({
      where: {
        tenantId: record.tenantKey,
        source: "BIGCOMMERCE",
        externalEventId: record.idempotencyKey,
      },
    });

    const logs = event
      ? await prisma.syncLog.findMany({
          where: {
            webhookEventId: event.id,
          },
          orderBy: {
            createdAt: "asc",
          },
          select: {
            id: true,
            status: true,
            attemptCount: true,
            errorMessage: true,
            createdAt: true,
            finishedAt: true,
          },
        })
      : [];

    console.log({
      idempotencyStatus: record.status,
      attemptCount: record.attemptCount,
      webhookStatus: event?.status,
      syncLogs: logs,
    });
  } finally {
    await prisma.$disconnect();
  }
}

inspect();