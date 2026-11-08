import { AuthenticationStrategyRegistry } from "./auth.registry.js";

import { NoneAuthenticationStrategy } from "./strategies/none.strategy.js";
import { ApiKeyAuthenticationStrategy } from "./strategies/api-key.strategy.js";
import { BasicAuthenticationStrategy } from "./strategies/basic.strategy.js";
import { BearerAuthenticationStrategy } from "./strategies/bearer.strategy.js";
import { OAuth2AuthenticationStrategy } from "./strategies/oauth2.strategy.js";

import type {
  OAuth2ProviderConfigResolver,
} from "./oauth2-provider-config.js";

import type {
  OAuth2TokenCoordinatorService,
} from "../../../shared/services/oauth2-token-coordinator.service.js";

/**
 * Dependencies required to construct the default authentication registry.
 *
 * OAuth2 provider configuration is injected because trusted provider
 * endpoints must be controlled by the application, not tenant input.
 */
export interface CreateAuthenticationRegistryOptions {
  oauth2ProviderConfigResolver: OAuth2ProviderConfigResolver;
  oauth2TokenCoordinator?: OAuth2TokenCoordinatorService;
}

/**
 * Creates a registry containing all supported authentication strategies.
 *
 * Supported authentication types:
 * NONE, API_KEY, BASIC, BEARER, OAUTH2.
 */
export function createDefaultAuthenticationRegistry(
  options: CreateAuthenticationRegistryOptions,
): AuthenticationStrategyRegistry {
  const registry = new AuthenticationStrategyRegistry();

  registry.register(new NoneAuthenticationStrategy());
  registry.register(new ApiKeyAuthenticationStrategy());
  registry.register(new BasicAuthenticationStrategy());
  registry.register(new BearerAuthenticationStrategy());

  registry.register(
    new OAuth2AuthenticationStrategy(
      options.oauth2ProviderConfigResolver,
      options.oauth2TokenCoordinator,
    ),
  );

  return registry;
}