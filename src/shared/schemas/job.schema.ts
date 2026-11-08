import { z } from "zod";

export const testConnectionSchema = z.object({
  message: z.string().min(1),
});

export const updateBcInventorySchema = z.object({
  tenantId: z.uuid(),
  integrationId: z.uuid(),
  webhookEventId: z.uuid().optional(),

  correlationId: z.string().min(1),

  scope: z.string().min(1),
  store_id: z.string().min(1),

  data: z.object({
    type: z.string(),
    id: z.number().int().positive(),
  }),

  productId: z.string().min(1),
  newQuantity: z.number().nonnegative(),
});