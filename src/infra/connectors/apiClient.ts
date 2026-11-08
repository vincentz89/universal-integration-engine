import axios, {
  AxiosHeaders,
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from "axios";

import {
  getRetryDelayMs,
  type RetryPolicyOptions,
} from "./retry-policy.js";

import type {
  AuthenticationExecutor,
} from "./auth/auth.executor.js";

import { logger } from "../../shared/utils/logger.js";

// Internal metadata used to track retry attempts per request.
type RetryableRequestConfig = InternalAxiosRequestConfig & {
  __retryAttempt?: number;
};

// Authentication context required for tenant-aware API requests.
export interface AuthenticatedApiClientOptions {
  tenantId: string;
  integrationId: string;
  expectedSystemName: string;
  executor: AuthenticationExecutor;
}

// HTTP methods that are generally safe to retry.
const RETRYABLE_METHODS = new Set([
  "get",
  "head",
  "options",
  "put",
  "delete",
]);

function canRetryRequest(
  config: InternalAxiosRequestConfig,
): boolean {
  const method = (config.method || "get").toLowerCase();

  if (RETRYABLE_METHODS.has(method)) {
    return true;
  }

  // POST is only retryable when the caller provides an idempotency key.
  if (method === "post") {
    const idempotencyKey = AxiosHeaders.from(
      config.headers,
    ).get("Idempotency-Key");

    return (
      typeof idempotencyKey === "string" &&
      idempotencyKey.trim().length > 0
    );
  }

  return false;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function createApiClientInternal(
  config: AxiosRequestConfig,
  retryPolicy: RetryPolicyOptions,
  authentication?: AuthenticatedApiClientOptions,
): AxiosInstance {
  const client = axios.create({
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...config,
  });

  const maxAttempts = retryPolicy.maxAttempts ?? 3;

  client.interceptors.request.use(
    async (reqConfig: InternalAxiosRequestConfig) => {
      let outgoingConfig = reqConfig;

      // Apply tenant-specific authentication before sending the request.
      if (authentication) {
        const authenticatedConfig =
          await authentication.executor.execute({
            tenantId: authentication.tenantId,
            integrationId: authentication.integrationId,
            expectedSystemName: authentication.expectedSystemName,
            request: reqConfig,
          });

        // Merge the strategy result into Axios's internal request config.
        outgoingConfig = Object.assign(
          reqConfig,
          authenticatedConfig,
        );
      }

      // Log metadata only. Never log headers, credentials, or tokens.
      logger.debug({
        method: outgoingConfig.method?.toUpperCase(),
      }, "[API OUT] Sending request");

      return outgoingConfig;
    },
    (error: AxiosError) => {
      logger.error(
        { code: error.code },
        "[API OUT ERROR] Failed to prepare request",
      );

      return Promise.reject(error);
    },
  );

  client.interceptors.response.use(
    (response) => {
      logger.debug({
        statusCode: response.status,
        method: response.config.method?.toUpperCase(),
      }, "[API IN] Request succeeded");

      return response;
    },
    async (error: AxiosError) => {
      const requestConfig = error.config as
        | RetryableRequestConfig
        | undefined;

      if (!requestConfig || !canRetryRequest(requestConfig)) {
        return Promise.reject(error);
      }

      const currentAttempt = requestConfig.__retryAttempt ?? 1;

      const delayMs = getRetryDelayMs(
        error,
        currentAttempt,
        retryPolicy,
      );

      if (delayMs === null) {
        logger.error({
          statusCode: error.response?.status,
          code: error.code,
          method: requestConfig.method?.toUpperCase(),
          attempt: currentAttempt,
        }, "[API IN ERROR] Request failed; retry unavailable");

        return Promise.reject(error);
      }

      logger.warn({
        statusCode: error.response?.status,
        code: error.code,
        method: requestConfig.method?.toUpperCase(),
        attempt: currentAttempt,
        nextAttempt: currentAttempt + 1,
        maxAttempts,
        delayMs,
      }, "[API RETRY] Retrying external API request");

      await wait(delayMs);

      requestConfig.__retryAttempt = currentAttempt + 1;

      // Request interceptors execute again, refreshing authentication
      // before the retried request is sent.
      return client.request(requestConfig);
    },
  );

  return client;
}

/**
 * Creates an unauthenticated Axios client with retry handling.
 *
 * Retained for backward compatibility and public API integrations.
 */
export const createApiClient = (
  config: AxiosRequestConfig,
  retryPolicy: RetryPolicyOptions = {},
): AxiosInstance => {
  return createApiClientInternal(config, retryPolicy);
};

/**
 * Creates an Axios client with tenant-specific authentication.
 *
 * Credentials are retrieved and applied by AuthenticationExecutor
 * before every outgoing request.
 */
export const createAuthenticatedApiClient = (
  config: AxiosRequestConfig,
  authentication: AuthenticatedApiClientOptions,
  retryPolicy: RetryPolicyOptions = {},
): AxiosInstance => {
  return createApiClientInternal(
    config,
    retryPolicy,
    authentication,
  );
};