
import { AxiosHeaders } from "axios";
import type { AxiosRequestConfig } from "axios";

import type { AuthenticationStrategy } from "../auth.strategy.js";
import type { AuthenticationContext } from "../auth.types.js";

import {
  oauth2TokenCoordinatorService,
} from "../../../../shared/services/oauth2-token-coordinator.service.js";

import type {
  OAuth2TokenCoordinatorService,
} from "../../../../shared/services/oauth2-token-coordinator.service.js";

import type {
  OAuth2ProviderConfigResolver,
} from "../oauth2-provider-config.js";

export class OAuth2AuthenticationStrategy
  implements AuthenticationStrategy<"OAUTH2">
{
  readonly authType = "OAUTH2" as const;

  constructor(
    private readonly providerConfigResolver: OAuth2ProviderConfigResolver,
    private readonly tokenCoordinator: OAuth2TokenCoordinatorService =
      oauth2TokenCoordinatorService,
  ) {}

  async apply(
    request: AxiosRequestConfig,
    context: AuthenticationContext<"OAUTH2">,
  ): Promise<AxiosRequestConfig> {
    // Validate trusted execution context.
    if (!context.tenantId?.trim()) {
      throw new Error("OAuth2 tenant ID is required.");
    }

    if (!context.integrationId?.trim()) {
      throw new Error("OAuth2 integration ID is required.");
    }

    if (!context.systemName?.trim()) {
      throw new Error("OAuth2 system name is required.");
    }

    // Resolve provider configuration from trusted application settings.
    const providerConfig = await this.providerConfigResolver.resolve({
      tenantId: context.tenantId,
      integrationId: context.integrationId,
      systemName: context.systemName,
    });

    // Obtain a valid token through the distributed refresh coordinator.
    const token = await this.tokenCoordinator.getAccessToken({
      tenantId: context.tenantId,
      integrationId: context.integrationId,
      expectedSystemName: context.systemName,
      tokenEndpointConfig: providerConfig.tokenEndpointConfig,
      allowedTokenHosts: providerConfig.allowedTokenHosts,
    });

    // Preserve existing request headers.
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

    // Apply the current access token.
    headers.set(
      "Authorization",
      `Bearer ${token.accessToken}`,
    );

    return {
      ...request,
      headers,
    };
  }
}
