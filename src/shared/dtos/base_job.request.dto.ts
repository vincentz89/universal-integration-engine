export interface BaseJobRequestDto {
  tenantId: string;
  integrationId: string;
  correlationId: string;
  webhookEventId?: string | undefined;
}