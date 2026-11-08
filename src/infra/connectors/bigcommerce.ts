import type { AxiosInstance } from "axios";

import {
  createAuthenticatedApiClient,
} from "./apiClient.js";

import {
  createApplicationAuthentication,
} from "./auth/create-application-authentication.js";

import {
  tenantCredentialService,
} from "../../shared/services/tenant-credential.service.js";

const BIGCOMMERCE_API_HOST = "api.bigcommerce.com";
const BIGCOMMERCE_SYSTEM_NAME = "BIGCOMMERCE";

const authentication = createApplicationAuthentication({
  oauth2Providers: {},
});

function validateBigCommerceBaseUrl(value: string | null): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("BigCommerce API base URL is missing.");
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(value);
  } catch {
    throw new Error("Invalid BigCommerce API base URL.");
  }

  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== BIGCOMMERCE_API_HOST ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new Error(
      "BigCommerce API base URL must use the official HTTPS API hostname.",
    );
  }

  if (!/^\/stores\/[^/]+\/v3\/?$/.test(baseUrl.pathname)) {
    throw new Error("Invalid BigCommerce API base URL path.");
  }

  return baseUrl.toString().replace(/\/$/, "");
}

export async function createBigCommerceClient(
  tenantId: string,
  integrationId: string,
): Promise<AxiosInstance> {
  const integration =
    await tenantCredentialService.getIntegrationMetadata(
      tenantId,
      integrationId,
      BIGCOMMERCE_SYSTEM_NAME,
    );

  const baseURL = validateBigCommerceBaseUrl(integration.baseUrl);

  return createAuthenticatedApiClient(
    { baseURL },
    {
      tenantId,
      integrationId,
      expectedSystemName: BIGCOMMERCE_SYSTEM_NAME,
      executor: authentication.executor,
    },
  );
}

export async function getProducts(
  tenantId: string,
  integrationId: string,
) {
  const client = await createBigCommerceClient(tenantId, integrationId);

  const response = await client.get("/catalog/products");

  return response.data;
}

export async function updateInventory(
  tenantId: string,
  integrationId: string,
  productId: string,
  quantity: number,
) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error(
      "Inventory quantity must be a non-negative safe integer.",
    );
  }

  const client = await createBigCommerceClient(tenantId, integrationId);

  const response = await client.put(
    `/catalog/products/${encodeURIComponent(productId)}`,
    { inventory_level: quantity },
  );

  return response.data;
}