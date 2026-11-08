import type { BaseJobRequestDto } from "./base_job.request.dto.js";

export interface UpdateBcInventoryRequestDto
  extends BaseJobRequestDto {
  scope: string;

  store_id: string;

  data: {
    type: string;
    id: number;
  };

  productId: string;
  newQuantity: number;
}