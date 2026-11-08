
import { AxiosHeaders } from "axios";
import type { AxiosRequestConfig } from "axios";

import type { AuthenticationStrategy } from "../auth.strategy.js";
import type {
  BearerAuthCredentials,
  AuthenticationContext,
} from "../auth.types.js";

const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "proxy-authorization",
]);

export class BearerAuthenticationStrategy
  implements AuthenticationStrategy<"BEARER">
{
  readonly authType = "BEARER" as const;

  apply(
    request: AxiosRequestConfig,
    context: AuthenticationContext<"BEARER">,
  ): AxiosRequestConfig {
    const credentials: BearerAuthCredentials = context.credentials;

    if (
      typeof credentials.accessToken !== "string" ||
      credentials.accessToken.trim().length === 0 ||
      credentials.accessToken !== credentials.accessToken.trim()
    ) {
      throw new Error("Bearer authentication access token is missing or invalid.");
    }

    const authConfig = context.authConfig ?? {};

    const headerName =
      typeof authConfig.headerName === "string"
        ? authConfig.headerName.trim()
        : "Authorization";

    const scheme =
      typeof authConfig.scheme === "string"
        ? authConfig.scheme.trim()
        : "Bearer";

    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) ||
      RESERVED_HEADERS.has(headerName.toLowerCase())
    ) {
      throw new Error("Invalid bearer authentication header name.");
    }

    if (
      scheme.length > 64 ||
      (scheme.length > 0 && !/^[A-Za-z][A-Za-z0-9._~-]*$/.test(scheme))
    ) {
      throw new Error("Invalid bearer authentication scheme.");
    }

    const headers = new AxiosHeaders();

    if (request.headers instanceof AxiosHeaders) {
      for (const [key, value] of Object.entries(request.headers.toJSON())) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }
    } else if (request.headers) {
      for (const [key, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }
    }

    // Remove stale origin-server authentication before applying this strategy.
    if (headerName.toLowerCase() !== "authorization") {
      headers.delete("Authorization");
    }

    const authenticationValue =
      scheme.length > 0
        ? `${scheme} ${credentials.accessToken}`
        : credentials.accessToken;

    headers.set(headerName, authenticationValue);

    return {
      ...request,
      headers,
    };
  }
}
