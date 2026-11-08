
import { AxiosHeaders } from "axios";
import type { AxiosRequestConfig } from "axios";

import type { AuthenticationStrategy } from "../auth.strategy.js";
import type {
  ApiKeyCredentials,
  AuthenticationContext,
} from "../auth.types.js";

type ApiKeyLocation = "HEADER" | "QUERY";

const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "proxy-authorization",
  "authorization",
]);

function getConfigString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid API key authentication configuration: ${key}.`,
    );
  }

  return value.trim();
}

function validateHeaderName(
  value: string,
  fieldName: string,
): string {
  const headerName = value.trim();

  // Validate the HTTP header field-name token format.
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) {
    throw new Error(
      `Invalid API key authentication header name: ${fieldName}.`,
    );
  }

  if (RESERVED_HEADERS.has(headerName.toLowerCase())) {
    throw new Error(
      `Reserved HTTP header cannot be used: ${fieldName}.`,
    );
  }

  return headerName;
}

function copyHeaders(
  request: AxiosRequestConfig,
): AxiosHeaders {
  const headers = new AxiosHeaders();

  if (request.headers instanceof AxiosHeaders) {
    for (const [key, value] of Object.entries(
      request.headers.toJSON(),
    )) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }
  } else if (request.headers) {
    for (const [key, value] of Object.entries(
      request.headers,
    )) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }
  }

  return headers;
}

export class ApiKeyAuthenticationStrategy
  implements AuthenticationStrategy<"API_KEY">
{
  readonly authType = "API_KEY" as const;

  apply(
    request: AxiosRequestConfig,
    context: AuthenticationContext<"API_KEY">,
  ): AxiosRequestConfig {
    const credentials: ApiKeyCredentials = context.credentials;
    const authConfig = context.authConfig ?? {};

    if (
      typeof credentials.apiKey !== "string" ||
      credentials.apiKey.trim().length === 0
    ) {
      throw new Error("API key credential is missing.");
    }

    const locationValue =
      getConfigString(authConfig, "location") ?? "HEADER";

    if (
      locationValue !== "HEADER" &&
      locationValue !== "QUERY"
    ) {
      throw new Error(
        "Unsupported API key authentication location.",
      );
    }

    const parameterName =
      getConfigString(authConfig, "parameterName") ?? "X-API-Key";

    const result: AxiosRequestConfig = { ...request };

    if (locationValue === "HEADER") {
      const headerName = validateHeaderName(
        parameterName,
        "parameterName",
      );

      const headers = copyHeaders(request);

      // Remove stale standard authentication credentials.
      headers.delete("Authorization");
      headers.delete("Proxy-Authorization");

      headers.set(headerName, credentials.apiKey);

      if (credentials.apiSecret !== undefined) {
        if (
          typeof credentials.apiSecret !== "string" ||
          credentials.apiSecret.trim().length === 0
        ) {
          throw new Error("API secret credential is invalid.");
        }

        const secretHeaderName = validateHeaderName(
          getConfigString(authConfig, "secretHeaderName") ??
            "X-API-Secret",
          "secretHeaderName",
        );

        if (
          secretHeaderName.toLowerCase() ===
          headerName.toLowerCase()
        ) {
          throw new Error(
            "API key and API secret must use different headers.",
          );
        }

        headers.set(secretHeaderName, credentials.apiSecret);
      }

      result.headers = headers;
    } else {
      if (credentials.apiSecret !== undefined) {
        throw new Error(
          "API secret requires header-based authentication.",
        );
      }

      if (
        request.params !== undefined &&
        (
          typeof request.params !== "object" ||
          request.params === null ||
          Array.isArray(request.params) ||
          request.params instanceof URLSearchParams
        )
      ) {
        throw new Error(
          "API key query authentication requires object-based request params.",
        );
      }

      // Remove stale authentication credentials before applying query authentication.
      const headers = copyHeaders(request);

      headers.delete("Authorization");
      headers.delete("Proxy-Authorization");

      result.headers = headers;

      result.params = {
        ...(request.params as Record<string, unknown> | undefined),
        [parameterName]: credentials.apiKey,
      };
    }

    return result;
  }
}
