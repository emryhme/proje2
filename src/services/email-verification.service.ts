import axios from 'axios';
import crypto from 'crypto';
import { db } from '../database/db';
import { env } from '../config/env';

const CODE_LIFETIME_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_FAILED_ATTEMPTS = 5;

export class EmailVerificationService {
  public static isConfigured(): boolean {
    return Boolean(env.resendApiKey && env.emailFrom);
  }

  public static tokenHash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  public static issueCode(userId: number): string {
    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = this.tokenHash(code);
    db.transaction(() => {
      db.prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(userId);
      db.prepare(`
        INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, failed_attempts)
        VALUES (?, ?, datetime('now', ?), 0)
      `).run(userId, codeHash, `+${CODE_LIFETIME_MINUTES} minutes`);
    })();
    return code;
  }

  public static canResend(userId: number): boolean {
    const row = db.prepare('SELECT created_at FROM email_verification_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) as { created_at?: string } | undefined;
    if (!row?.created_at) return true;
    const createdAt = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime();
    return Date.now() - createdAt >= RESEND_COOLDOWN_SECONDS * 1000;
  }

  public static consumeCode(email: string, code: string): { success: boolean; userId?: number; reason?: string } {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.trim();
    if (!cleanEmail || !/^\d{6}$/.test(cleanCode)) return { success: false, reason: 'invalid' };

    const row = db.prepare(`
      SELECT evt.id, evt.user_id, evt.token_hash, evt.failed_attempts, u.email
      FROM email_verification_tokens evt
      JOIN users u ON u.id = evt.user_id
      WHERE LOWER(u.email) = ? AND evt.used_at IS NULL AND evt.expires_at > CURRENT_TIMESTAMP
      ORDER BY evt.id DESC
      LIMIT 1
    `).get(cleanEmail) as any;
    if (!row || row.failed_attempts >= MAX_FAILED_ATTEMPTS) return { success: false, reason: 'invalid_or_expired' };

    const actual = Buffer.from(this.tokenHash(cleanCode), 'hex');
    const expected = Buffer.from(row.token_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      db.prepare('UPDATE email_verification_tokens SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(row.id);
      return { success: false, reason: row.failed_attempts + 1 >= MAX_FAILED_ATTEMPTS ? 'too_many_attempts' : 'invalid' };
    }

    db.transaction(() => {
      db.prepare('UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?').run(row.user_id);
      db.prepare("UPDATE merchant_applications SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?) AND status = 'email_pending'").run(row.email);
    })();
    return { success: true, userId: row.user_id };
  }

  public static async sendVerificationEmail(input: { userId: number; email: string; fullName: string }): Promise<void> {
    if (!this.isConfigured()) throw new Error('E-posta servisi yapılandırılmamış.');
    const code = this.issueCode(input.userId);
    await axios.post('https://api.resend.com/emails', {
      from: env.emailFrom,
      to: [input.email],
      subject: `${code} — ISCWORKS doğrulama kodunuz`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h2>Merhaba ${this.escapeHtml(input.fullName)},</h2><p>ISCWORKS mağaza başvurunuza devam etmek için aşağıdaki kodu doğrulama ekranına girin.</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3f4f6;padding:18px;text-align:center;border-radius:10px;margin:26px 0">${code}</div><p style="font-size:13px;color:#6b7280">Kod 10 dakika geçerlidir ve yalnızca bir kez kullanılabilir.</p><p style="font-size:12px;color:#9ca3af">Bu kaydı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.</p></div>`,
      text: `ISCWORKS tek kullanımlık doğrulama kodunuz: ${code}\n\nKod 10 dakika geçerlidir.`
    }, {
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `verify-code-${input.userId}-${this.tokenHash(code).slice(0, 20)}`
      },
      timeout: 15_000
    });
  }

  public static async sendAccountApprovedEmail(input: { email: string; fullName: string; storeName: string }): Promise<void> {
    if (!this.isConfigured()) throw new Error('E-posta servisi yapılandırılmamış.');
    const loginUrl = 'https://www.iscworks.tr/admin/login';
    await axios.post('https://api.resend.com/emails', {
      from: env.emailFrom,
      to: [input.email],
      subject: 'ISCWORKS mağaza hesabınız onaylandı',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h2>Merhaba ${this.escapeHtml(input.fullName)},</h2><p><strong>${this.escapeHtml(input.storeName)}</strong> mağaza hesabınız süper admin tarafından onaylandı.</p><p>Artık ISCWORKS yönetim paneline giriş yapabilir, mağaza ayarlarınızı tamamlayabilir ve satış asistanınızı kullanmaya başlayabilirsiniz.</p><p style="margin:28px 0"><a href="${loginUrl}" style="background:#111827;color:#fff;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:700">Yönetim Paneline Giriş Yap</a></p><p style="font-size:12px;color:#9ca3af">Bu e-posta ISCWORKS mağaza başvurunuzun sonucu hakkında gönderilmiştir.</p></div>`,
      text: `Merhaba ${input.fullName},\n\n${input.storeName} mağaza hesabınız onaylandı. Artık yönetim paneline giriş yapabilirsiniz:\n${loginUrl}`
    }, {
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `account-approved-${this.tokenHash(input.email.toLowerCase()).slice(0, 24)}`
      },
      timeout: 15_000
    });
  }

  public static async sendPlanSupportResponseEmail(input: { email: string; fullName: string; storeName: string; requestedPlan: string; adminNote: string; resolved: boolean; requestId: number }): Promise<void> {
    if (!this.isConfigured()) throw new Error('E-posta servisi yapılandırılmamış.');
    const planUrl = 'https://www.iscworks.tr/admin/plan';
    const statusText = input.resolved ? 'yanıtlandı' : 'sonuçlandırıldı';
    await axios.post('https://api.resend.com/emails', {
      from: env.emailFrom,
      to: [input.email],
      subject: `ISCWORKS plan talebiniz ${statusText}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h2>Merhaba ${this.escapeHtml(input.fullName)},</h2><p><strong>${this.escapeHtml(input.storeName)}</strong> mağazanız için oluşturduğunuz <strong>${this.escapeHtml(input.requestedPlan)}</strong> plan talebi ${statusText}.</p><div style="background:#f3f4f6;padding:18px;border-radius:10px;margin:22px 0"><strong>Destek yanıtı</strong><p style="white-space:pre-wrap">${this.escapeHtml(input.adminNote)}</p></div><p><a href="${planUrl}" style="background:#111827;color:#fff;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:700">Plan Yönetimini Aç</a></p></div>`,
      text: `Merhaba ${input.fullName},\n\n${input.storeName} mağazanızın ${input.requestedPlan} plan talebi ${statusText}.\n\nDestek yanıtı:\n${input.adminNote}\n\n${planUrl}`
    }, {
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plan-support-${input.requestId}-${input.resolved ? 'resolved' : 'rejected'}`
      },
      timeout: 15_000
    });
  }

  private static escapeHtml(value: string): string {
    return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character] || character));
  }
}
