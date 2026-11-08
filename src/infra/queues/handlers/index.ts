import { registerWebhookHandler } from "./handler-registry.js";

// Example product handler.
// Replace this implementation with actual product synchronization logic.
registerWebhookHandler(
  "BIGCOMMERCE",
  "product",
  async (event) => {
    console.info("[Product Handler] Received event:", {
      tenantId: event.tenantId,
      eventType: event.eventType,
      resourceId: event.resourceId,
    });

    // Retrieve the complete product from the provider API here.
    // Transform the provider response into your internal domain model.
    // Dispatch the transformed data to the configured destination adapter.

    return {
      accepted: true,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
    };
  },
);

// Test-only handler for verifying idempotency lease renewal.
if (process.env.ENABLE_STRESS_TEST_HANDLERS === "true") {
  registerWebhookHandler(
    "BIGCOMMERCE",
    "lease-test",
    async (event) => {
      console.info(
        "[Lease Test Handler] Started:",
        event.resourceId,
      );

      // Deliberately exceed the default 60-second lease.
      await new Promise((resolve) =>
        setTimeout(resolve, 75_000),
      );

      console.info(
        "[Lease Test Handler] Finished:",
        event.resourceId,
      );

      return {
        success: true,
        test: "LEASE_RENEWAL",
        resourceId: event.resourceId,
        durationMs: 75_000,
      };
    },
  );
}

// Test-only handler for actual worker crash recovery.
if (process.env.ENABLE_STRESS_TEST_HANDLERS === "true") {
  registerWebhookHandler(
    "BIGCOMMERCE",
    "lease-crash",
    async (event) => {
      if (process.env.CRASH_TEST_MODE === "true") {
        console.info(
          "[Crash Test Handler] Worker A started:",
          event.resourceId,
        );

        // Intentionally keep Worker A busy.
        // We will terminate its process manually.
        // await new Promise((resolve) =>
        //   setTimeout(resolve, 300_000),
        // );

        setTimeout(() => {
          console.error("[Crash Test Handler] Simulating unexpected process crash.");
          process.exit(1);
        }, 5_000);

        await new Promise(() => {});
      }

      console.info(
        "[Crash Test Handler] Replacement worker completed:",
        event.resourceId,
      );

      return {
        success: true,
        recovered: true,
        resourceId: event.resourceId,
      };
    },
  );
}

// Add more handlers using the same registration contract.
// BIGCOMMERCE:order
// BIGCOMMERCE:customer
// BIGCOMMERCE:variant
// D365:product
// SHOPIFY:order