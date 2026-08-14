"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailVerificationService = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../database/db");
const env_1 = require("../config/env");
const CODE_LIFETIME_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_FAILED_ATTEMPTS = 5;
class EmailVerificationService {
    static isConfigured() {
        return Boolean(env_1.env.resendApiKey && env_1.env.emailFrom);
    }
    static tokenHash(value) {
        return crypto_1.default.createHash('sha256').update(value).digest('hex');
    }
    static issueCode(userId) {
        const code = crypto_1.default.randomInt(100000, 1000000).toString();
        const codeHash = this.tokenHash(code);
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(userId);
            db_1.db.prepare(`
        INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, failed_attempts)
        VALUES (?, ?, datetime('now', ?), 0)
      `).run(userId, codeHash, `+${CODE_LIFETIME_MINUTES} minutes`);
        })();
        return code;
    }
    static canResend(userId) {
        const row = db_1.db.prepare('SELECT created_at FROM email_verification_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
        if (!row?.created_at)
            return true;
        const createdAt = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime();
        return Date.now() - createdAt >= RESEND_COOLDOWN_SECONDS * 1000;
    }
    static consumeCode(email, code) {
        const cleanEmail = email.trim().toLowerCase();
        const cleanCode = code.trim();
        if (!cleanEmail || !/^\d{6}$/.test(cleanCode))
            return { success: false, reason: 'invalid' };
        const row = db_1.db.prepare(`
      SELECT evt.id, evt.user_id, evt.token_hash, evt.failed_attempts, u.email
      FROM email_verification_tokens evt
      JOIN users u ON u.id = evt.user_id
      WHERE LOWER(u.email) = ? AND evt.used_at IS NULL AND evt.expires_at > CURRENT_TIMESTAMP
      ORDER BY evt.id DESC
      LIMIT 1
    `).get(cleanEmail);
        if (!row || row.failed_attempts >= MAX_FAILED_ATTEMPTS)
            return { success: false, reason: 'invalid_or_expired' };
        const actual = Buffer.from(this.tokenHash(cleanCode), 'hex');
        const expected = Buffer.from(row.token_hash, 'hex');
        if (actual.length !== expected.length || !crypto_1.default.timingSafeEqual(actual, expected)) {
            db_1.db.prepare('UPDATE email_verification_tokens SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(row.id);
            return { success: false, reason: row.failed_attempts + 1 >= MAX_FAILED_ATTEMPTS ? 'too_many_attempts' : 'invalid' };
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
            db_1.db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?').run(row.user_id);
            db_1.db.prepare("UPDATE merchant_applications SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?) AND status = 'email_pending'").run(row.email);
        })();
        return { success: true, userId: row.user_id };
    }
    static async sendVerificationEmail(input) {
        if (!this.isConfigured())
            throw new Error('E-posta servisi yapılandırılmamış.');
        const code = this.issueCode(input.userId);
        await axios_1.default.post('https://api.resend.com/emails', {
            from: env_1.env.emailFrom,
            to: [input.email],
            subject: `${code} — ISCWORKS doğrulama kodunuz`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h2>Merhaba ${this.escapeHtml(input.fullName)},</h2><p>ISCWORKS mağaza başvurunuza devam etmek için aşağıdaki kodu doğrulama ekranına girin.</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3f4f6;padding:18px;text-align:center;border-radius:10px;margin:26px 0">${code}</div><p style="font-size:13px;color:#6b7280">Kod 10 dakika geçerlidir ve yalnızca bir kez kullanılabilir.</p><p style="font-size:12px;color:#9ca3af">Bu kaydı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.</p></div>`,
            text: `ISCWORKS tek kullanımlık doğrulama kodunuz: ${code}\n\nKod 10 dakika geçerlidir.`
        }, {
            headers: {
                Authorization: `Bearer ${env_1.env.resendApiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `verify-code-${input.userId}-${this.tokenHash(code).slice(0, 20)}`
            },
            timeout: 15_000
        });
    }
    static escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
    }
}
exports.EmailVerificationService = EmailVerificationService;
