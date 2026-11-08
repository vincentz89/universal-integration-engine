
import { AxiosHeaders } from "axios";
import type { AxiosRequestConfig } from "axios";

import type { AuthenticationStrategy } from "../auth.strategy.js";
import type {
  BasicAuthCredentials,
  AuthenticationContext,
} from "../auth.types.js";

export class BasicAuthenticationStrategy
  implements AuthenticationStrategy<"BASIC">
{
  readonly authType = "BASIC" as const;

  apply(
    request: AxiosRequestConfig,
    context: AuthenticationContext<"BASIC">,
  ): AxiosRequestConfig {
    const credentials: BasicAuthCredentials = context.credentials;

    if (
      typeof credentials.username !== "string" ||
      credentials.username.trim().length === 0
    ) {
      throw new Error("Basic authentication username is missing.");
    }

    if (credentials.username.includes(":")) {
      throw new Error(
        "Basic authentication username cannot contain a colon.",
      );
    }

    if (
      typeof credentials.password !== "string" ||
      credentials.password.trim().length === 0
    ) {
      throw new Error("Basic authentication password is missing.");
    }

    // Encode credentials using UTF-8 before Base64 conversion.
    const encodedCredentials = Buffer.from(
      `${credentials.username}:${credentials.password}`,
      "utf8",
    ).toString("base64");

    // Preserve existing headers, including separate proxy authentication.
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

    // Replace any existing origin-server authentication.
    headers.set("Authorization", `Basic ${encodedCredentials}`);

    return {
      ...request,
      headers,
    };
  }
}
