import type {
  OAuth2ProviderConfig,
  OAuth2ProviderConfigResolver,
} from "./oauth2-provider-config.js";

export type TrustedOAuth2ProviderRegistry = Readonly<
  Record<string, OAuth2ProviderConfig>
>;

export class StaticOAuth2ProviderConfigResolver
  implements OAuth2ProviderConfigResolver
{
  constructor(
    private readonly providers: TrustedOAuth2ProviderRegistry,
  ) {}

  async resolve(input: {
    tenantId: string;
    integrationId: string;
    systemName: string;
  }): Promise<OAuth2ProviderConfig> {
    this.validateInput(input);

    const systemName = input.systemName.trim().toUpperCase();

    const provider = this.providers[systemName];

    if (!provider) {
      throw new Error(
        `OAuth2 configuration is not registered for provider: ${systemName}`,
      );
    }

    return provider;
  }

  private validateInput(input: {
    tenantId: string;
    integrationId: string;
    systemName: string;
  }): void {
    if (
      typeof input.tenantId !== "string" ||
      input.tenantId.trim().length === 0
    ) {
      throw new Error("Tenant ID is required.");
    }

    if (
      typeof input.integrationId !== "string" ||
      input.integrationId.trim().length === 0
    ) {
      throw new Error("Integration ID is required.");
    }

    if (
      typeof input.systemName !== "string" ||
      input.systemName.trim().length === 0
    ) {
      throw new Error("Provider system name is required.");
    }
  }
}