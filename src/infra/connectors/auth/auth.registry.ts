import type { AuthType } from "./auth.types.js";
import type { AuthenticationStrategy } from "./auth.strategy.js";

/**
 * Stores registered authentication strategies.
 *
 * Each authentication type must have only one registered strategy.
 */
export class AuthenticationStrategyRegistry {
  private readonly strategies = new Map<
    AuthType,
    AuthenticationStrategy<AuthType>
  >();

  register(strategy: AuthenticationStrategy<AuthType>): void {
    if (this.strategies.has(strategy.authType)) {
      throw new Error(
        `Authentication strategy "${strategy.authType}" is already registered.`,
      );
    }

    this.strategies.set(strategy.authType, strategy);
  }

  get(authType: AuthType): AuthenticationStrategy<AuthType> {
    const strategy = this.strategies.get(authType);

    if (!strategy) {
      throw new Error(
        `Authentication strategy "${authType}" is not registered.`,
      );
    }

    return strategy;
  }

  has(authType: AuthType): boolean {
    return this.strategies.has(authType);
  }

  getRegisteredTypes(): AuthType[] {
    return Array.from(this.strategies.keys());
  }
}