
import { AxiosHeaders } from "axios";
import type { AxiosRequestConfig } from "axios";

import type { AuthenticationStrategy } from "../auth.strategy.js";
import type {
  AuthenticationContext,
} from "../auth.types.js";

/**
 * Authentication strategy for public APIs.
 *
 * Removes existing standard authentication headers
 * to prevent reuse of stale credentials.
 */
export class NoneAuthenticationStrategy
  implements AuthenticationStrategy<"NONE">
{
  readonly authType = "NONE" as const;

  apply(
    config: AxiosRequestConfig,
    _context: AuthenticationContext<"NONE">,
  ): AxiosRequestConfig {
    const headers = new AxiosHeaders();

    if (config.headers instanceof AxiosHeaders) {
      for (const [key, value] of Object.entries(
        config.headers.toJSON(),
      )) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }
    } else if (config.headers) {
      for (const [key, value] of Object.entries(
        config.headers,
      )) {
        if (value !== undefined) {
          headers.set(key, value);
        }
      }
    }

    headers.delete("Authorization");
    headers.delete("Proxy-Authorization");

    return {
      ...config,
      headers,
    };
  }
}
