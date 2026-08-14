"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const zod_1 = require("zod");
dotenv_1.default.config({ path: path_1.default.join(__dirname, '../../.env') });
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().default('3000').transform((v) => parseInt(v, 10)),
    NODE_ENV: zod_1.z.string().default('development'),
    DATABASE_PATH: zod_1.z.string().trim().min(1).default('./barons.db'),
    FB_VERIFY_TOKEN: zod_1.z.string().trim().min(1, 'FB_VERIFY_TOKEN is required.'),
    FB_PAGE_ACCESS_TOKEN: zod_1.z.string().default(''),
    INSTAGRAM_APP_ID: zod_1.z.string().trim().default(''),
    INSTAGRAM_APP_SECRET: zod_1.z.string().trim().min(1).optional(),
    INSTAGRAM_OAUTH_REDIRECT_URI: zod_1.z.string().trim().url().optional(),
    OPENAI_API_KEY: zod_1.z.string().default(''),
    OPENAI_MODEL: zod_1.z.string().default('gpt-4o'),
    GEMINI_API_KEY: zod_1.z.string().default(''),
    RESEND_API_KEY: zod_1.z.string().trim().default(''),
    EMAIL_FROM: zod_1.z.string().trim().default('ISCWORKS <onay@mail.iscworks.info>'),
    TELEGRAM_BOT_TOKEN: zod_1.z.string().default(''),
    TELEGRAM_CHAT_ID: zod_1.z.string().default(''),
    N8N_WEBHOOK_URL: zod_1.z.string().default(''),
    JWT_SECRET: zod_1.z.string().trim().min(32, 'JWT_SECRET must be at least 32 characters long.'),
    BOOTSTRAP_MASTER_ADMIN: zod_1.z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    MASTER_ADMIN_NAME: zod_1.z.string().trim().min(1).default('Platform Administrator'),
    MASTER_ADMIN_EMAIL: zod_1.z.string().trim().email().optional(),
    MASTER_ADMIN_PASSWORD: zod_1.z.string().min(12).optional(),
    CORS_ORIGINS: zod_1.z.string().default('*')
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
exports.env = {
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
    bootstrapMasterAdmin: envValues.BOOTSTRAP_MASTER_ADMIN,
    masterAdminName: envValues.MASTER_ADMIN_NAME,
    masterAdminEmail: envValues.MASTER_ADMIN_EMAIL,
    masterAdminPassword: envValues.MASTER_ADMIN_PASSWORD,
    corsOrigins: envValues.CORS_ORIGINS
};
