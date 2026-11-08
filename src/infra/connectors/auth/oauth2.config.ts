
import { z } from "zod";

export const OAuth2ClientAuthenticationSchema = z.enum([
  "CLIENT_SECRET_BASIC",
  "CLIENT_SECRET_POST",
]);

export const OAuth2TokenEndpointConfigSchema = z
  .object({
    tokenUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);

          return (
            url.protocol === "https:" &&
            url.username === "" &&
            url.password === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      }, "OAuth2 token URL must be a valid HTTPS URL."),

    clientAuthentication:
      OAuth2ClientAuthenticationSchema.default(
        "CLIENT_SECRET_BASIC",
      ),

    scope: z.string().trim().min(1).optional(),

    audience: z.string().trim().min(1).optional(),
  })
  .strict();

export const OAuth2TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),

    token_type: z.string().min(1).optional(),

    expires_in: z.number().int().positive().optional(),

    refresh_token: z.string().min(1).optional(),

    scope: z.string().optional(),
  })
  .passthrough();

// Input type: clientAuthentication may be omitted because Zod supplies a default.
export type OAuth2TokenEndpointConfigInput = z.input<
  typeof OAuth2TokenEndpointConfigSchema
>;

// Output type: clientAuthentication is always present after parsing.
export type OAuth2TokenEndpointConfig = z.infer<
  typeof OAuth2TokenEndpointConfigSchema
>;

export type OAuth2TokenResponse = z.infer<
  typeof OAuth2TokenResponseSchema
>;
