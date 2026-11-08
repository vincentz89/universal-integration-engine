// Central registry of supported queue job names.
// Add new job types here instead of hardcoding strings throughout the application.

export const JOB_NAMES = {
  TEST_CONNECTION: "TEST_CONNECTION",
  PROCESS_WEBHOOK_EVENT: "PROCESS_WEBHOOK_EVENT",
} as const;

export type JobName =
  (typeof JOB_NAMES)[keyof typeof JOB_NAMES];