import {
  createDefaultAuthenticationRegistry,
} from "./create-auth-registry.js";

import {
  StaticOAuth2ProviderConfigResolver,
} from "./static-oauth2-provider-config-resolver.js";

import type {
  TrustedOAuth2ProviderRegistry,
} from "./static-oauth2-provider-config-resolver.js";

import type {
  OAuth2TokenCoordinatorService,
} from "../../../shared/services/oauth2-token-coordinator.service.js";

import {
  AuthenticationExecutor,
} from "./auth.executor.js";

export interface CreateApplicationAuthenticationOptions {
  /**
   * Trusted OAuth2 provider configurations controlled by the application.
   */
  oauth2Providers: TrustedOAuth2ProviderRegistry;

  /**
   * Optional coordinator override, primarily useful for testing.
   */
  oauth2TokenCoordinator?: OAuth2TokenCoordinatorService;
}

/**
 * Creates the application-level authentication components.
 *
 * This is the composition point connecting:
 * - Trusted OAuth2 provider configuration
 * - Authentication strategy registry
 * - Authentication executor
 *
 * Tenant-specific credentials are still retrieved through
 * the tenant credential service.
 */
export function createApplicationAuthentication(
  options: CreateApplicationAuthenticationOptions,
) {
  const providerResolver =
    new StaticOAuth2ProviderConfigResolver(
      options.oauth2Providers,
    );

  const registry = createDefaultAuthenticationRegistry({
    oauth2ProviderConfigResolver: providerResolver,
    ...(options.oauth2TokenCoordinator
      ? {
          oauth2TokenCoordinator: options.oauth2TokenCoordinator,
        }
      : {}),
  });

  const executor = new AuthenticationExecutor(registry);

  return {
    executor,
    registry,
    providerResolver,
  };
}