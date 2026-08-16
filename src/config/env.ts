import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envSchema = z.object({
  PORT: z.string().default('3000').transform((v) => parseInt(v, 10)),
  NODE_ENV: z.string().default('development'),
  DATABASE_PATH: z.string().trim().min(1).default('./barons.db'),
  FB_VERIFY_TOKEN: z.string().trim().min(1, 'FB_VERIFY_TOKEN is required.'),
  FB_PAGE_ACCESS_TOKEN: z.string().default(''),
  INSTAGRAM_APP_ID: z.string().trim().default(''),
  INSTAGRAM_APP_SECRET: z.string().trim().min(1).optional(),
  INSTAGRAM_OAUTH_REDIRECT_URI: z.string().trim().url().optional(),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  GEMINI_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().trim().default(''),
  EMAIL_FROM: z.string().trim().default('ISCWORKS <onay@mail.iscworks.info>'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  N8N_WEBHOOK_URL: z.string().default(''),
  JWT_SECRET: z.string().trim().min(32, 'JWT_SECRET must be at least 32 characters long.'),
  SESSION_TTL_HOURS: z.string().default('12').transform((v) => Math.min(168, Math.max(1, parseInt(v, 10) || 12))),
  DATA_RETENTION_DAYS: z.string().default('180').transform((v) => Math.min(3650, Math.max(30, parseInt(v, 10) || 180))),
  PENDING_REGISTRATION_RETENTION_DAYS: z.string().default('30').transform((v) => Math.min(365, Math.max(7, parseInt(v, 10) || 30))),
  BOOTSTRAP_MASTER_ADMIN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MASTER_ADMIN_NAME: z.string().trim().min(1).default('Platform Administrator'),
  MASTER_ADMIN_EMAIL: z.string().trim().email().optional(),
  MASTER_ADMIN_PASSWORD: z.string().min(12).optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000')
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  const messages = parsedEnv.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration. ${messages}`);
}

const envValues = parsedEnv.data;

if (envValues.BOOTSTRAP_MASTER_ADMIN && (!envValues.MASTER_ADMIN_EMAIL || !envValues.MASTER_ADMIN_PASSWORD)) {
  throw new Error('MASTER_ADMIN_EMAIL and MASTER_ADMIN_PASSWORD are required when BOOTSTRAP_MASTER_ADMIN=true.');
}

if (Boolean(envValues.TELEGRAM_BOT_TOKEN) !== Boolean(envValues.TELEGRAM_CHAT_ID)) {
  throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together.');
}

if (envValues.NODE_ENV === 'production' && envValues.CORS_ORIGINS.trim() === '*') {
  throw new Error('CORS_ORIGINS cannot be * in production. Configure the public site origin explicitly.');
}

export const env = {
  port: envValues.PORT,
  nodeEnv: envValues.NODE_ENV,
  databasePath: envValues.DATABASE_PATH,
  fbVerifyToken: envValues.FB_VERIFY_TOKEN,
  fbPageAccessToken: envValues.FB_PAGE_ACCESS_TOKEN,
  instagramAppId: envValues.INSTAGRAM_APP_ID,
  instagramAppSecret: envValues.INSTAGRAM_APP_SECRET,
  instagramOauthRedirectUri: envValues.INSTAGRAM_OAUTH_REDIRECT_URI,
  openaiApiKey: envValues.OPENAI_API_KEY,
  openaiModel: envValues.OPENAI_MODEL,
  geminiApiKey: envValues.GEMINI_API_KEY,
  resendApiKey: envValues.RESEND_API_KEY,
  emailFrom: envValues.EMAIL_FROM,
  telegramBotToken: envValues.TELEGRAM_BOT_TOKEN,
  telegramChatId: envValues.TELEGRAM_CHAT_ID,
  n8nWebhookUrl: envValues.N8N_WEBHOOK_URL,
  jwtSecret: envValues.JWT_SECRET,
  sessionTtlHours: envValues.SESSION_TTL_HOURS,
  dataRetentionDays: envValues.DATA_RETENTION_DAYS,
  pendingRegistrationRetentionDays: envValues.PENDING_REGISTRATION_RETENTION_DAYS,
  bootstrapMasterAdmin: envValues.BOOTSTRAP_MASTER_ADMIN,
  masterAdminName: envValues.MASTER_ADMIN_NAME,
  masterAdminEmail: envValues.MASTER_ADMIN_EMAIL,
  masterAdminPassword: envValues.MASTER_ADMIN_PASSWORD,
  corsOrigins: envValues.CORS_ORIGINS
};
