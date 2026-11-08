import type { AxiosRequestConfig } from "axios";

import type {
  AuthType,
  AuthenticationContext,
} from "./auth.types.js";

import type {
  AuthenticationStrategyRegistry,
} from "./auth.registry.js";

import {
  tenantCredentialService,
} from "../../../shared/services/tenant-credential.service.js";

import type {
  TenantCredentialService,
} from "../../../shared/services/tenant-credential.service.js";

export interface ExecuteAuthenticationInput {
  tenantId: string;
  integrationId: string;
  expectedSystemName: string;
  request: AxiosRequestConfig;
}

export class AuthenticationExecutor {
  constructor(
    private readonly registry: AuthenticationStrategyRegistry,
    private readonly credentialService: TenantCredentialService =
      tenantCredentialService,
  ) {}

  /**
   * Loads tenant-specific credentials and applies the registered
   * authentication strategy to an Axios request configuration.
   */
  async execute(
    input: ExecuteAuthenticationInput,
  ): Promise<AxiosRequestConfig> {
    this.validateInput(input);

    // Retrieve credentials using tenant-scoped database lookup.
    const integration =
      await this.credentialService.getIntegrationCredentials(
        input.tenantId,
        input.integrationId,
        input.expectedSystemName,
      );

    const authType: AuthType = integration.authType;

    // Select the authentication strategy.
    const strategy = this.registry.get(authType);

    // Construct trusted authentication context.
    const context: AuthenticationContext = {
      authType,
      credentials: integration.credentials,
      authConfig: integration.authConfig,
      tenantId: integration.tenantId,
      integrationId: integration.id,
      systemName: integration.systemName,
    } as AuthenticationContext;

    // Apply the selected authentication strategy.
    return strategy.apply(input.request, context);
  }

  private validateInput(input: ExecuteAuthenticationInput): void {
    if (!input.tenantId.trim()) {
      throw new Error("Authentication tenant ID is required.");
    }

    if (!input.integrationId.trim()) {
      throw new Error("Authentication integration ID is required.");
    }

    if (!input.expectedSystemName.trim()) {
      throw new Error("Authentication system name is required.");
    }

    if (
      typeof input.request !== "object" ||
      input.request === null ||
      Array.isArray(input.request)
    ) {
      throw new Error("A valid Axios request configuration is required.");
    }
  }
}

export const authenticationExecutor = (
  registry: AuthenticationStrategyRegistry,
): AuthenticationExecutor => {
  return new AuthenticationExecutor(registry);
};