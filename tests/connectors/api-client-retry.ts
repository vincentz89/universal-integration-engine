import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApiClient } from "../../src/infra/connectors/apiClient.js";

const attempts = new Map<string, number>();

function recordAttempt(path: string): number {
  const count = (attempts.get(path) ?? 0) + 1;
  attempts.set(path, count);
  return count;
}

const server = createServer((req, res) => {
  const path = req.url ?? "/";
  const attempt = recordAttempt(path);

  res.setHeader("Content-Type", "application/json");

  // Simulate a temporary HTTP 503 failure.
  if (path === "/retry-503" && attempt === 1) {
    res.writeHead(503).end(JSON.stringify({ error: "Service unavailable" }));
    return;
  }

  // Simulate HTTP 429 with Retry-After.
  if (path === "/retry-429" && attempt === 1) {
    res.writeHead(429, { "Retry-After": "0" }).end(
      JSON.stringify({ error: "Too many requests" }),
    );
    return;
  }

  // POST without an idempotency key must not be retried.
  if (path === "/post-unsafe") {
    res.writeHead(503).end(JSON.stringify({ error: "Service unavailable" }));
    return;
  }

  // POST with an idempotency key can be retried.
  if (path === "/post-idempotent" && attempt === 1) {
    res.writeHead(503).end(JSON.stringify({ error: "Service unavailable" }));
    return;
  }

    // Simulate a service that continuously returns HTTP 503.
  if (path === "/always-503") {
    res.writeHead(503).end(
      JSON.stringify({ error: "Service unavailable" }),
    );
    return;
  }

  // Simulate a permanent HTTP 400 error.
  if (path === "/bad-request") {
    res.writeHead(400).end(
      JSON.stringify({ error: "Invalid request" }),
    );
    return;
  }

  res.writeHead(200).end(JSON.stringify({ success: true }));
});

async function runTests() {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Could not determine test server address.");
    }

    const client = createApiClient(
      {
        baseURL: `http://127.0.0.1:${address.port}`,
      },
      {
        maxAttempts: 2,
        baseDelayMs: 5,
        maxDelayMs: 5,
        jitterRatio: 0,
      },
    );

    console.log("\n======================================");
    console.log("EXTERNAL API RETRY TEST");
    console.log("======================================");

    // TEST 1: HTTP 503 should retry and succeed.
    const serviceUnavailable = await client.get("/retry-503");

    assert.equal(serviceUnavailable.status, 200);
    assert.equal(attempts.get("/retry-503"), 2);

    console.log("[PASS] HTTP 503 retry");

    // TEST 2: HTTP 429 should respect Retry-After.
    const rateLimited = await client.get("/retry-429");

    assert.equal(rateLimited.status, 200);
    assert.equal(attempts.get("/retry-429"), 2);

    console.log("[PASS] HTTP 429 Retry-After");

    // TEST 3: POST without idempotency key must not retry.
    await assert.rejects(
      client.post("/post-unsafe", { value: 1 }),
    );

    assert.equal(attempts.get("/post-unsafe"), 1);

    console.log("[PASS] Unsafe POST is not retried");

    // TEST 4: POST with idempotency key can retry.
    const idempotentPost = await client.post(
      "/post-idempotent",
      { value: 1 },
      {
        headers: {
          "Idempotency-Key": "retry-test-001",
        },
      },
    );

    assert.equal(idempotentPost.status, 200);
    assert.equal(attempts.get("/post-idempotent"), 2);

    console.log("[PASS] Idempotent POST retry");

    // TEST 5: Stop retrying after maximum attempts.
    await assert.rejects(
      client.get("/always-503"),
    );

    assert.equal(attempts.get("/always-503"), 2);

    console.log("[PASS] Retry exhaustion stops at maximum attempts");

    // TEST 6: HTTP 400 must not be retried.
    await assert.rejects(
      client.get("/bad-request"),
    );

    assert.equal(attempts.get("/bad-request"), 1);

    console.log("[PASS] HTTP 400 is not retried");

    console.log("--------------------------------------");
    console.log("ALL 6 RETRY TESTS PASSED");
    console.log("======================================");

  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

runTests().catch((error: unknown) => {
  console.error("[FAIL] External API retry test:", error);
  process.exitCode = 1;
});
