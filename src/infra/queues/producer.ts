// Keep a single dispatch implementation.
// Existing modules can continue importing from producer.ts.

export { dispatchSyncJob } from "./queue.js";