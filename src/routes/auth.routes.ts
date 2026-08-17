import { Router } from 'express';
import crypto from 'crypto';
import { db, hashPassword, needsPasswordRehash, verifyPassword } from '../database/db';
import { env } from '../config/env';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { EmailVerificationService } from '../services/email-verification.service';
import { clearSessionCookie, createRateLimiter, sessionCookie, setSessionCookie } from '../middleware/security.middleware';

const router = Router();
const STRONG_PASSWORD_PATTERN = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 5, message: 'Çok fazla kayıt denemesi yapıldı. Lütfen daha sonra tekrar deneyin.' });
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 8, message: 'Çok fazla giriş denemesi yapıldı. Lütfen 15 dakika sonra tekrar deneyin.' });
const verificationLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'Çok fazla doğrulama denemesi yapıldı. Lütfen daha sonra tekrar deneyin.' });
const resendLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 3, message: 'Çok fazla kod gönderim isteği yapıldı. Lütfen daha sonra tekrar deneyin.' });

function secureValueMatches(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash('sha256').update(actual).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function uniqueStoreSlug(storeName: string): string {
  const base = storeName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'magaza';
  if (!db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(base)) return base;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!db.prepare('SELECT 1 FROM stores WHERE slug = ?').get(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

router.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { fullName, phone, email, storeName, plan, password } = req.body || {};
    if (!fullName || !phone || !email || !storeName || !password) {
      return res.status(400).json({ success: false, error: 'Lütfen tüm zorunlu alanları doldurun.' });
    }
    if (!STRONG_PASSWORD_PATTERN.test(String(password))) {
      return res.status(400).json({ success: false, error: 'Şifre en az 8 karakter olmalı; bir büyük harf, bir sayı ve bir özel karakter içermelidir.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanStoreName = String(storeName).trim();
    const storeSlug = uniqueStoreSlug(cleanStoreName);
    const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existingUser) return res.status(400).json({ success: false, error: 'Bu e-posta adresi ile zaten bir hesap veya başvuru mevcuttur.' });

    const hashedPassword = hashPassword(String(password));
    let resultUser: any = null;
    let resultStore: any = null;
    db.transaction(() => {
      const userRes = db.prepare("INSERT INTO users (full_name, email, phone, password_hash, status) VALUES (?, ?, ?, ?, 'pending')").run(fullName, cleanEmail, phone, hashedPassword);
      const userId = Number(userRes.lastInsertRowid);
      const storeRes = db.prepare("INSERT INTO stores (owner_id, name, slug, status) VALUES (?, ?, ?, 'pending')").run(userId, cleanStoreName, storeSlug);
      const storeId = Number(storeRes.lastInsertRowid);
      db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (?, ?, 'OWNER', 'pending')").run(userId, storeId);
      db.prepare("INSERT INTO merchant_applications (full_name, email, store_name, plan, status) VALUES (?, ?, ?, ?, 'email_pending')").run(fullName, cleanEmail, cleanStoreName, plan || 'Pro Store');
      AuthMiddleware.logAudit(storeId, userId, 'REGISTER_EMAIL_PENDING', 'users', String(userId), '', cleanEmail);
      resultUser = { id: userId, email: cleanEmail, name: String(fullName) };
      resultStore = { id: storeId, name: cleanStoreName, slug: storeSlug };
    })();

    let emailSent = true;
    try {
      await EmailVerificationService.sendVerificationEmail({ userId: resultUser.id, email: resultUser.email, fullName: resultUser.name });
    } catch (emailError: any) {
      emailSent = false;
      console.error('[Email Verification] Initial send failed:', emailError?.response?.data || emailError?.message || emailError);
    }

    return res.json({
      success: true,
      emailSent,
      message: emailSent
        ? 'Kayıt oluşturuldu. E-posta adresinize gönderilen bağlantıyla adresinizi doğrulayın.'
        : 'Kayıt oluşturuldu ancak doğrulama e-postası gönderilemedi. Lütfen tekrar gönder düğmesini kullanın.',
      user: { id: resultUser.id, email: resultUser.email, name: resultUser.name, storeId: resultStore.id, storeSlug: resultStore.slug, status: 'email_pending' }
    });
  } catch (err: any) {
    console.error('[Register Error]:', err);
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ success: false, error: 'Bu e-posta veya mağaza adı kullanılmaktadır.' });
    return res.status(500).json({ success: false, error: 'Kayıt esnasında sunucu hatası oluştu.' });
  }
});

router.post('/api/auth/verify-email', verificationLimiter, (req, res) => {
  const email = String(req.body?.email || '');
  const code = String(req.body?.code || '');
  const result = EmailVerificationService.consumeCode(email, code);
  if (!result.success) {
    const error = result.reason === 'too_many_attempts'
      ? 'Çok fazla hatalı deneme yapıldı. Lütfen yeni kod isteyin.'
      : 'Doğrulama kodu hatalı veya süresi dolmuş.';
    return res.status(400).json({ success: false, error, code: result.reason });
  }
  return res.json({ success: true, message: 'E-posta adresiniz doğrulandı. Başvurunuz süper admin onayına gönderildi.' });
});

router.post('/api/auth/resend-verification', resendLimiter, async (req, res) => {
  const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
  const genericResponse = { success: true, message: 'Hesap doğrulama bekliyorsa yeni bağlantı e-posta adresine gönderildi.' };
  if (!cleanEmail) return res.status(400).json({ success: false, error: 'E-posta adresi zorunludur.' });
  const user = db.prepare('SELECT id, full_name, email, email_verified_at FROM users WHERE LOWER(email) = ?').get(cleanEmail) as any;
  if (!user || user.email_verified_at) return res.json(genericResponse);
  if (!EmailVerificationService.canResend(user.id)) return res.status(429).json({ success: false, error: 'Yeni e-posta istemeden önce 60 saniye bekleyin.' });
  try {
    await EmailVerificationService.sendVerificationEmail({ userId: user.id, email: user.email, fullName: user.full_name });
    return res.json(genericResponse);
  } catch (error: any) {
    console.error('[Email Verification] Resend failed:', error?.response?.data || error?.message || error);
    return res.status(502).json({ success: false, error: 'Doğrulama e-postası şu anda gönderilemedi. Lütfen daha sonra tekrar deneyin.' });
  }
});

router.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, email, password } = req.body || {};
  const cleanEmail = (email || username || '').trim().toLowerCase();
  const cleanPass = typeof password === 'string' ? password : '';
  if (!cleanEmail || !cleanPass) return res.status(400).json({ success: false, error: 'E-posta ve şifre zorunludur.' });

  const user = db.prepare('SELECT id, full_name, email, password_hash, status, email_verified_at, session_version FROM users WHERE LOWER(email) = ?').get(cleanEmail) as any;
  const isMasterAccount = Boolean(user && (user.id === 1 || db.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND store_id = 1 AND role = 'OWNER' LIMIT 1").get(user.id)));
  const suppliedMasterPanelKey = String(req.headers['x-master-panel-key'] || '').trim();
  if (isMasterAccount && !secureValueMatches(suppliedMasterPanelKey, env.masterAdminPanelPath)) {
    return res.status(401).json({ success: false, error: 'Geçersiz e-posta veya şifre.' });
  }
  if (!user || !verifyPassword(cleanPass, user.password_hash)) return res.status(401).json({ success: false, error: 'Geçersiz e-posta veya şifre.' });
  if (needsPasswordRehash(user.password_hash)) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPass), user.id);
  if (!user.email_verified_at && user.id !== 1) return res.status(403).json({ success: false, code: 'EMAIL_NOT_VERIFIED', error: 'Giriş yapmadan önce e-posta adresinizi doğrulayın.' });
  if (user.status === 'pending') return res.status(403).json({ success: false, error: 'E-posta adresiniz doğrulandı. Hesabınız süper admin onayı bekliyor.' });
  if (user.status !== 'active') return res.status(403).json({ success: false, error: 'Hesabınız pasif durumdadır.' });

  const memberships = db.prepare(`SELECT m.store_id, m.role, s.name AS store_name, s.slug AS store_slug FROM memberships m JOIN stores s ON s.id = m.store_id WHERE m.user_id = ? AND m.status = 'active' AND s.status = 'active' ORDER BY m.id ASC`).all(user.id) as any[];
  if (!memberships.length) return res.status(403).json({ success: false, error: 'Aktif ve onaylanmış bir mağaza üyeliğiniz bulunmamaktadır.' });
  const reqStoreId = Number(req.body?.storeId);
  const activeMem = (reqStoreId && memberships.find(m => m.store_id === reqStoreId)) || memberships[0];
  const token = AuthMiddleware.generateToken({ userId: user.id, storeId: activeMem.store_id, role: activeMem.role, email: user.email, sessionVersion: user.session_version });
  setSessionCookie(res, token);
  AuthMiddleware.logAudit(activeMem.store_id, user.id, 'LOGIN', 'users', String(user.id), '', user.email);
  return res.json({ success: true, token, user: { id:user.id, email:user.email, name:user.full_name, storeId:activeMem.store_id, storeName:activeMem.store_name, storeSlug:activeMem.store_slug, role:activeMem.role } });
});

router.post('/api/auth/logout', (req, res) => {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : sessionCookie(req);
  const payload = AuthMiddleware.verifyToken(token);
  if (payload?.userId) db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(payload.userId);
  clearSessionCookie(res);
  return res.json({ success: true });
});

router.get('/api/auth/verify', AuthMiddleware.authenticate, (req: AuthenticatedRequest, res) => res.json({ success: true, valid: true, user: req.auth }));

export default router;
