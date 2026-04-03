import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    KURIER_URL: z.string().url(),
    KURIER_API: z.string().min(1),
    SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
