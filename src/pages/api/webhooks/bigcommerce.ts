
import type {
  NextApiRequest,
  NextApiResponse,
} from "next";

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { bigCommerceWebhookIntakeService } from "../../../infra/webhooks/bigcommerce/webhook-intake.service.js";
import { tenantCredentialService } from "../../../shared/services/tenant-credential.service.js";
import { prisma } from "../../../shared/utils/db.js";
import { logger } from "../../../shared/utils/logger.js";

import {
  verifyBigCommerceSignature,
} from "../../../infra/webhooks/bigcommerce/signature-verifier.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

import {
  MAX_WEBHOOK_BODY_BYTES,
  PayloadTooLargeError,
  readLimitedRequestBody,
} from "../../../shared/utils/read-limited-request-body.js";

// 1. Validate the BigCommerce webhook structure.
const BigCommerceWebhookSchema = z.object({
  scope: z.string().min(1),
  store_id: z.union([
    z.string().min(1),
    z.number(),
  ]),
  data: z.record(z.string(), z.unknown()),
  hash: z.string().optional(),
  producer: z.string().optional(),
  created_at: z.number().optional(),
}).passthrough();

type BigCommerceWebhookPayload = z.infer<
  typeof BigCommerceWebhookSchema
>;

// 5. Extract generic resource information.
function extractResourceInformation(
  payload: BigCommerceWebhookPayload,
) {
  const data = payload.data;

  const resourceType =
    typeof data.type === "string"
      ? data.type
      : payload.scope.split("/")[1] ?? "unknown";

  const possibleIds = [
    data.id,
    data.product_id,
    data.variant_id,
    data.resource_id,
  ];

  const resourceIdValue = possibleIds.find(
    (value) =>
      typeof value === "string" ||
      typeof value === "number",
  );

  return {
    resourceType,
    ...(resourceIdValue !== undefined
      ? { resourceId: String(resourceIdValue) }
      : {}),
  };
}

// 6. Main webhook handler.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    // A. Read the original request.
    const rawBody = await readLimitedRequestBody(req);

    if (rawBody.length === 0) {
      return res.status(400).json({
        error: "Empty webhook payload.",
      });
    }

    // B. Read verification headers.
    const webhookId = req.headers["webhook-id"];
    const webhookTimestamp =
      req.headers["webhook-timestamp"];
    const webhookSignature =
      req.headers["webhook-signature"];

    if (
      typeof webhookId !== "string" ||
      typeof webhookTimestamp !== "string" ||
      typeof webhookSignature !== "string"
    ) {
      return res.status(401).json({
        error: "Missing webhook verification headers.",
      });
    }

    // C. Parse incoming JSON.
    let unsafeBody: unknown;

    try {
      unsafeBody = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({
        error: "Malformed JSON payload.",
      });
    }

    // D. Validate the webhook structure.
    const validation =
      BigCommerceWebhookSchema.safeParse(unsafeBody);

    if (!validation.success) {
      return res.status(400).json({
        error: "Invalid webhook structure.",
      });
    }

    const validData = validation.data;
    const storeId = String(validData.store_id);

    // E. Resolve the exact active integration using the provider account ID.
    const matchingIntegrations =
      await prisma.tenantIntegrationConfig.findMany({
        where: {
          systemName: "BIGCOMMERCE",
          externalAccountId: storeId,
          isActive: true,
          tenant: {
            isActive: true,
          },
        },
        include: {
          tenant: true,
        },
        take: 2,
      });

    if (matchingIntegrations.length === 0) {
      logger.warn(
        { storeId },
        "Webhook rejected: unknown or inactive provider account.",
      );

      return res.status(403).json({
        error: "Unknown or inactive provider account.",
      });
    }

    if (matchingIntegrations.length > 1) {
      logger.error(
        { storeId },
        "Webhook rejected: multiple integrations match the provider account.",
      );

      return res.status(500).json({
        error: "Ambiguous integration configuration.",
      });
    }

    const integration = matchingIntegrations[0];

    if (!integration) {
      return res.status(500).json({
        error: "Integration configuration error.",
      });
    }

    const tenant = integration.tenant;

    if (!integration) {
      logger.error(
        { tenantId: tenant.id },
        "BigCommerce integration configuration is missing.",
      );

      return res.status(500).json({
        error: "Integration configuration error.",
      });
    }

    let webhookSecret: string;

    try {
      const credentials =
        await tenantCredentialService.getIntegrationCredentials(
          tenant.id,
          integration.id,
          "BIGCOMMERCE",
        );

      const configuredSecret = credentials.credentials.webhookSecret;

      if (
        typeof configuredSecret !== "string" ||
        configuredSecret.trim().length === 0
      ) {
        throw new Error("Webhook secret is missing.");
      }

      webhookSecret = configuredSecret;
    } catch (error) {
      logger.error(
        {
          tenantId: tenant.id,
          integrationId: integration.id,
          error:
            error instanceof Error
              ? error.message
              : "Unknown credential retrieval error.",
        },
        "Unable to retrieve BigCommerce webhook credentials.",
      );

      return res.status(500).json({
        error: "Integration configuration error.",
      });
    }

    // F. Authenticate the original request.
    const signatureIsValid = verifyBigCommerceSignature(
      rawBody,
      webhookSecret,
      webhookId,
      webhookTimestamp,
      webhookSignature,
    );

    if (!signatureIsValid) {
      logger.warn(
        { storeId, webhookId },
        "Webhook rejected: invalid signature.",
      );

      return res.status(401).json({
        error: "Invalid webhook signature.",
      });
    }

    // G. Generate idempotency information.
    const externalEventId =
      validData.hash ?? webhookId;

    const requestHash = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");

    // H. Convert the validated payload into Prisma JSON.
    const webhookPayload = JSON.parse(
      JSON.stringify(validData),
    ) as Prisma.InputJsonValue;

    // I. Extract resource metadata.
    const resource = extractResourceInformation(validData);

    // J. Register everything through one transaction.
    const result = await bigCommerceWebhookIntakeService.register({
      tenantId: tenant.id,
      integrationId: integration.id,
      externalEventId,
      requestHash,
      eventType: validData.scope,
      resourceType: resource.resourceType,
      ...(resource.resourceId !== undefined
        ? { resourceId: resource.resourceId }
        : {}),
      webhookPayload,
    });

    // K. Handle idempotency conflicts.
    if (result.status === "CONFLICT") {
      logger.warn(
        {
          tenantId: tenant.id,
          externalEventId,
        },
        "Webhook rejected: idempotency key payload conflict.",
      );

      return res.status(409).json({
        success: false,
        error: "Idempotency key conflict.",
      });
    }

    // L. Handle duplicate deliveries.
    if (result.status === "DUPLICATE") {
      logger.info(
        {
          tenantId: tenant.id,
          externalEventId,
          webhookEventId: result.webhookEventId,
        },
        "Duplicate webhook delivery acknowledged.",
      );

      return res.status(200).json({
        success: true,
        duplicate: true,
        ...(result.webhookEventId
          ? { webhookEventId: result.webhookEventId }
          : {}),
      });
    }

    // M. Handle events requiring recovery.
    if (result.status === "RETRY_REQUIRED") {
      logger.warn(
        {
          tenantId: tenant.id,
          externalEventId,
        },
        "Webhook retry requires recovery.",
      );

      return res.status(503).json({
        success: false,
        error: "Webhook processing requires recovery.",
      });
    }

    // N. NEW or RETRY_CLAIMED.
    // The transaction has committed and the Outbox
    // Worker will handle queue dispatch separately.
    // N. NEW or RETRY_CLAIMED.
    if (
      result.status !== "NEW" &&
      result.status !== "RETRY_CLAIMED"
    ) {
      throw new Error(
        `Unexpected webhook intake status: ${result.status}`,
      );
    }

    logger.info(
      {
        tenantId: tenant.id,
        integrationId: integration.id,
        webhookEventId: result.webhookEventId,
        syncLogId: result.syncLogId,
        outboxEventId: result.outboxEventId,
        idempotencyRecordId: result.idempotencyRecordId,
        externalEventId,
        intakeStatus: result.status,
      },
      "BigCommerce webhook accepted into transactional outbox.",
    );

    return res.status(202).json({
      success: true,
      accepted: true,
      status: result.status,
      webhookEventId: result.webhookEventId,
    });

  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn(
        {
          maxBodyBytes: MAX_WEBHOOK_BODY_BYTES,
        },
        "Webhook rejected: request body exceeds the configured size limit.",
      );

      res.setHeader("Connection", "close");

      res.once("finish", () => {
        if (!req.socket.destroyed) {
          req.socket.destroy();
        }
      });

      return res.status(413).json({
        error: "Webhook payload too large.",
      });
    }

    logger.error(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown webhook intake error.",
      },
      "BigCommerce webhook intake failed.",
    );

    return res.status(500).json({
      error: "Internal Server Error.",
    });
  }
}
