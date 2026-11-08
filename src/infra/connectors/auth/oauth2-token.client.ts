
import axios from "axios";
import type { AxiosRequestConfig } from "axios";

import {
  OAuth2TokenEndpointConfigSchema,
  OAuth2TokenResponseSchema,
} from "./oauth2.config.js";

import type {
  OAuth2TokenEndpointConfig,
  OAuth2TokenEndpointConfigInput,
  OAuth2TokenResponse,
} from "./oauth2.config.js";

import type { OAuth2Credentials } from "./auth.types.js";

export interface OAuth2TokenHttpClient {
  post(
    url: string,
    data: string,
    config: AxiosRequestConfig,
  ): Promise<{ data: unknown }>;
}

export interface RefreshOAuth2TokenInput {
  config: OAuth2TokenEndpointConfigInput;
  credentials: OAuth2Credentials;
  allowedTokenHosts: readonly string[];
}

function validateTokenUrl(
  tokenUrl: string,
  allowedTokenHosts: readonly string[],
): URL {
  let url: URL;

  try {
    url = new URL(tokenUrl);
  } catch {
    throw new Error("Invalid OAuth2 token endpoint URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new Error("OAuth2 token endpoint URL is not permitted.");
  }

  const allowedHosts = new Set(
    allowedTokenHosts.map((host) => host.trim().toLowerCase()),
  );

  if (
    allowedHosts.size === 0 ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error(
      "OAuth2 token endpoint host is not in the trusted allowlist.",
    );
  }

  return url;
}


function formEncode(value: string): string {
  return new URLSearchParams([["value", value]])
    .toString()
    .slice("value=".length);
}

function buildRefreshRequest(
  config: OAuth2TokenEndpointConfig,
  credentials: OAuth2Credentials,
): {
  body: URLSearchParams;
  headers: Record<string, string>;
} {
  if (
    typeof credentials.clientId !== "string" ||
    credentials.clientId.length === 0
  ) {
    throw new Error("OAuth2 client ID is missing.");
  }

  if (
    typeof credentials.clientSecret !== "string" ||
    credentials.clientSecret.length === 0
  ) {
    throw new Error("OAuth2 client secret is missing.");
  }

  if (
    typeof credentials.refreshToken !== "string" ||
    credentials.refreshToken.trim().length === 0
  ) {
    throw new Error("OAuth2 refresh token is missing.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  });

  if (config.scope) {
    body.set("scope", config.scope);
  }

  if (config.audience) {
    body.set("audience", config.audience);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.clientAuthentication === "CLIENT_SECRET_BASIC") {
    // OAuth2 requires form-encoding each credential before Base64 encoding.
    const encodedClientId = formEncode(credentials.clientId);
    const encodedClientSecret = formEncode(credentials.clientSecret);

    const basicCredentials = Buffer.from(
      `${encodedClientId}:${encodedClientSecret}`,
      "utf8",
    ).toString("base64");

    headers.Authorization = `Basic ${basicCredentials}`;
  } else {
    body.set("client_id", credentials.clientId);
    body.set("client_secret", credentials.clientSecret);
  }

  return { body, headers };
}


export async function refreshOAuth2AccessToken(
  input: RefreshOAuth2TokenInput,
  httpClient?: OAuth2TokenHttpClient,
): Promise<OAuth2TokenResponse> {
  const parsedConfig = OAuth2TokenEndpointConfigSchema.safeParse(
    input.config,
  );

  if (!parsedConfig.success) {
    throw new Error("Invalid OAuth2 token endpoint configuration.");
  }

  const config = parsedConfig.data;

  const tokenUrl = validateTokenUrl(
    config.tokenUrl,
    input.allowedTokenHosts,
  );

  const { body, headers } = buildRefreshRequest(
    config,
    input.credentials,
  );

  // No automatic retries or redirects for token refresh requests.
  const client =
    httpClient ??
    axios.create({
      timeout: 15_000,
      maxRedirects: 0,
    });

  let response: { data: unknown };

  try {
    response = await client.post(
      tokenUrl.toString(),
      body.toString(),
      {
        headers,
        timeout: 15_000,
        maxRedirects: 0,
      },
    );
  } catch {
    // Do not expose Axios request details or provider response data.
    throw new Error("OAuth2 token refresh request failed.");
  }

  const parsedResponse = OAuth2TokenResponseSchema.safeParse(
    response.data,
  );

  if (!parsedResponse.success) {
    throw new Error("OAuth2 provider returned an invalid token response.");
  }

  if (
    typeof parsedResponse.data.token_type !== "string" ||
    parsedResponse.data.token_type.toLowerCase() !== "bearer"
  ) {
    throw new Error("OAuth2 provider returned an unsupported token type.");
  }

  return parsedResponse.data;
}
