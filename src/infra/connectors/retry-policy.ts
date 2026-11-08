import axios, { type AxiosError } from "axios";

export interface RetryPolicyOptions {
  // Maximum number of total attempts, including the first request.
  maxAttempts?: number;

  // Initial exponential backoff delay.
  baseDelayMs?: number;

  // Maximum exponential backoff delay.
  maxDelayMs?: number;

  // Random jitter percentage to prevent synchronized retries.
  jitterRatio?: number;
}

const DEFAULT_RETRY_POLICY: Required<RetryPolicyOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterRatio: 0.2,
};

// HTTP statuses that are considered temporary failures.
const RETRYABLE_STATUS_CODES = new Set([
  429,
  500,
  502,
  503,
  504,
]);

// Network errors that may recover on a subsequent attempt.
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ERR_NETWORK",
]);

// Determines whether an Axios error is eligible for retry.
export function isRetryableError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const axiosError = error as AxiosError;

  // Check HTTP response status.
  const statusCode = axiosError.response?.status;

  if (statusCode !== undefined) {
    return RETRYABLE_STATUS_CODES.has(statusCode);
  }

  // No response usually indicates a network or connection failure.
  return (
    axiosError.code !== undefined &&
    RETRYABLE_NETWORK_CODES.has(axiosError.code)
  );
}

// Parses Retry-After in seconds or HTTP-date format.
export function getRetryAfterMs(
  error: AxiosError,
  now: number = Date.now(),
): number | null {
  const retryAfter = error.response?.headers?.["retry-after"];

  if (retryAfter === undefined || retryAfter === null) {
    return null;
  }

  const value = String(retryAfter).trim();

  // Retry-After expressed as seconds.
  const seconds = Number(value);

  if (value !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  // Retry-After expressed as an HTTP date.
  const retryDate = Date.parse(value);

  if (Number.isNaN(retryDate)) {
    return null;
  }

  return Math.max(0, retryDate - now);
}

// Calculates the delay before the next retry.
// Returns null when the error should not be retried.
export function getRetryDelayMs(
  error: unknown,
  attempt: number,
  options: RetryPolicyOptions = {},
): number | null {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    ...options,
  };

  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1
  ) {
    throw new Error("Retry maxAttempts must be an integer >= 1.");
  }

  if (
    !Number.isFinite(policy.baseDelayMs) ||
    policy.baseDelayMs < 0
  ) {
    throw new Error("Retry baseDelayMs must be a finite number >= 0.");
  }

  if (
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < 0
  ) {
    throw new Error("Retry maxDelayMs must be a finite number >= 0.");
  }

  if (
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new Error("Retry jitterRatio must be between 0 and 1.");
  }

  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt >= policy.maxAttempts
  ) {
    return null;
  }

  if (!isRetryableError(error)) {
    return null;
  }

  const axiosError = error as AxiosError;

  // The server's Retry-After instruction takes priority.
  const retryAfterMs = getRetryAfterMs(axiosError);

  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  // Exponential backoff.
  const exponentialDelay = Math.min(
    policy.baseDelayMs * 2 ** (attempt - 1),
    policy.maxDelayMs,
  );

  // Apply jitter to avoid retrying many requests simultaneously.
  const jitterMultiplier =
    1 + (Math.random() * 2 - 1) * policy.jitterRatio;

  return Math.max(
    0,
    Math.round(exponentialDelay * jitterMultiplier),
  );
}