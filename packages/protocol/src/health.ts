import { z } from "zod";

/** `GET /api/v1/health`: whether the service is up and can reach its database. */
export const healthResponse = z.object({
  status: z.enum(["ok", "unavailable"]),
  database: z.enum(["ok", "unavailable"]),
});

export type HealthResponse = z.infer<typeof healthResponse>;
