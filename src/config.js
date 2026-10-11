import 'dotenv/config';
import { z } from 'zod';

export function readConfig(env = process.env) {
  return z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/).default('1h'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  }).parse(env);
}
