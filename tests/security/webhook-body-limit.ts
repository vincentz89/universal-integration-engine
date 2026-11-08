import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";

import {
  MAX_WEBHOOK_BODY_BYTES,
  PayloadTooLargeError,
  readLimitedRequestBody,
} from "../../src/shared/utils/read-limited-request-body.js";

function createRequest(
  headers: Record<string, string> = {},
): PassThrough & { headers: IncomingMessage["headers"] } {
  const request = new PassThrough() as PassThrough & {
    headers: IncomingMessage["headers"];
  };

  request.headers = headers;

  return request;
}

async function main(): Promise<void> {
  let passed = 0;

  async function test(
    name: string,
    callback: () => Promise<void>,
  ): Promise<void> {
    await callback();
    passed++;
    console.log(`[PASS] ${name}`);
  }

  console.log("======================================");
  console.log("WEBHOOK BODY LIMIT SECURITY TEST");
  console.log("======================================");

  // 1. Reject oversized Content-Length before reading the body.
  await test("Rejects oversized declared Content-Length", async () => {
    const request = createRequest({
      "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
    });

    await assert.rejects(
      readLimitedRequestBody(request as unknown as IncomingMessage),
      PayloadTooLargeError,
    );
  });

  // 2. Reject oversized bodies without Content-Length.
  await test("Rejects oversized streamed request body", async () => {
    const request = createRequest();

    const result = readLimitedRequestBody(
      request as unknown as IncomingMessage,
    );

    request.end(Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1));

    await assert.rejects(result, PayloadTooLargeError);
  });

  // 3. Accept a body exactly at the configured limit.
  await test("Accepts body exactly at the size limit", async () => {
    const request = createRequest();

    const result = readLimitedRequestBody(
      request as unknown as IncomingMessage,
    );

    const body = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES, "a");
    request.end(body);

    const received = await result;

    assert.equal(received.length, MAX_WEBHOOK_BODY_BYTES);
    assert.deepEqual(received, body);
  });

  // 4. Accept a normal request body.
  await test("Accepts a body below the size limit", async () => {
    const request = createRequest();
    const expected = Buffer.from('{"scope":"store/order/created"}');

    const result = readLimitedRequestBody(
      request as unknown as IncomingMessage,
    );

    request.end(expected);

    const received = await result;

    assert.deepEqual(received, expected);
  });

  console.log("--------------------------------------");
  console.log(`PASSED: ${passed}`);
  console.log("FAILED: 0");
  console.log("FINAL RESULT: ALL TESTS PASSED");
  console.log("======================================");
}

main().catch((error: unknown) => {
  console.error("[FAIL] Webhook body limit test:", error);
  process.exitCode = 1;
});