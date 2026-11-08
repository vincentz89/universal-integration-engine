import "dotenv/config";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  IncomingHttpHeaders,
} from "node:http";

import type { Socket } from "node:net";
import type {
  NextApiRequest,
  NextApiResponse,
} from "next";

import handler from "../../src/pages/api/webhooks/bigcommerce.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
} from "../../src/shared/utils/read-limited-request-body.js";

async function main(): Promise<void> {
  const request = new PassThrough() as unknown as NextApiRequest;

  const response = new EventEmitter() as unknown as NextApiResponse;

  const responseState: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = {
    headers: {},
  };

  let socketDestroyed = false;

  Object.assign(request, {
    method: "POST",
    headers: {
      "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
    } as IncomingHttpHeaders,
    socket: {
      destroyed: false,
      destroy() {
        socketDestroyed = true;
      },
    } as unknown as Socket,
  });

  Object.assign(response, {
    status(code: number) {
      responseState.statusCode = code;
      return response;
    },
    json(body: unknown) {
      responseState.body = body;
      return response;
    },
    setHeader(name: string, value: string) {
      responseState.headers[name] = value;
      return response;
    },
  });

  console.log("======================================");
  console.log("WEBHOOK ROUTE SECURITY TEST");
  console.log("======================================");

  await handler(request, response);

  assert.equal(responseState.statusCode, 413);

  assert.deepEqual(responseState.body, {
    error: "Webhook payload too large.",
  });

  assert.equal(
    responseState.headers["Connection"],
    "close",
  );

  assert.equal(socketDestroyed, false);

  response.emit("finish");

  assert.equal(socketDestroyed, true);

  console.log("[PASS] Socket destroyed after response finishes");

  console.log("[PASS] Actual API handler returns HTTP 413");
  console.log("[PASS] Correct error response returned");
  console.log("[PASS] Connection close header configured");
  console.log("[PASS] Socket is not destroyed before response finishes");

  console.log("--------------------------------------");
  console.log("PASSED: 5");
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
  console.log("======================================");
}

main().catch((error: unknown) => {
  console.error("[FAIL] Webhook route test:", error);
  process.exitCode = 1;
});