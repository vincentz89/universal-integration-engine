
import type {
  AxiosRequestConfig,
} from "axios";

import type {
  AuthType,
  AuthenticationContext,
} from "./auth.types.js";

/**
 * Authentication strategy contract.
 *
 * Each strategy receives a generic authentication context
 * and returns Axios request configuration containing
 * the required authentication information.
 */
export interface AuthenticationStrategy<
  T extends AuthType = AuthType,
> {
  readonly authType: T;

  apply(
    config: AxiosRequestConfig,
    context: AuthenticationContext<T>,
  ): AxiosRequestConfig | Promise<AxiosRequestConfig>;
}
