
import type { IntegrationAuthType } from "@prisma/client";

/**
 * Common credential payload structure.
 *
 * All credential values must be strings because the credential
 * service serializes and encrypts this payload before database storage.
 */
export type CredentialPayload = Record<string, string>;

/**
 * Authentication credentials required by each authentication strategy.
 *
 * Provider-specific fields are allowed so the framework can support
 * integrations with additional credential requirements.
 */
export interface NoAuthCredentials extends CredentialPayload {}

export interface ApiKeyCredentials extends CredentialPayload {
  apiKey: string;
  apiSecret?: string;
}

export interface BasicAuthCredentials extends CredentialPayload {
  username: string;
  password: string;
}

export interface BearerAuthCredentials extends CredentialPayload {
  accessToken: string;
}

export interface OAuth2Credentials extends CredentialPayload {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Maps authentication types to their respective credential structures.
 */
export interface AuthCredentialsMap {
  NONE: NoAuthCredentials;
  API_KEY: ApiKeyCredentials;
  BASIC: BasicAuthCredentials;
  BEARER: BearerAuthCredentials;
  OAUTH2: OAuth2Credentials;
}

/**
 * Authentication type is sourced from the Prisma-generated enum.
 */
export type AuthType = IntegrationAuthType;

/**
 * Non-secret authentication configuration.
 *
 * Examples:
 * - API key header name
 * - API key query parameter name
 * - OAuth2 token endpoint
 * - OAuth2 scopes
 *
 * Never store passwords, API keys, client secrets, or tokens here.
 */
export type AuthConfig = Record<string, unknown>;

/**
 * Generic authentication context passed to strategies.
 *
 * Tenant and integration identifiers are supplied by the
 * trusted integration execution pipeline.
 */
export interface AuthenticationContext<
  T extends AuthType = AuthType,
> {
  authType: T;
  credentials: AuthCredentialsMap[T];
  authConfig?: AuthConfig | null;

  // Required by tenant-aware authentication strategies.
  tenantId?: string;
  integrationId?: string;
  systemName?: string;
}
