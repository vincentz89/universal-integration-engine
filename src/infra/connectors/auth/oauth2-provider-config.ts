
import type {
  OAuth2TokenEndpointConfigInput,
} from "./oauth2.config.js";

/**
 * Provider-controlled OAuth2 configuration.
 *
 * These values must come from trusted application configuration,
 * not directly from tenant-provided credentials or arbitrary URLs.
 */
export interface OAuth2ProviderConfig {
  tokenEndpointConfig: OAuth2TokenEndpointConfigInput;
  allowedTokenHosts: readonly string[];
}

/**
 * Resolves OAuth2 configuration for a specific integration.
 *
 * Implementations can later load provider settings from:
 * - Application configuration
 * - A trusted provider registry
 * - A validated integration configuration service
 */
export interface OAuth2ProviderConfigResolver {
  resolve(input: {
    tenantId: string;
    integrationId: string;
    systemName: string;
  }): Promise<OAuth2ProviderConfig>;
}
