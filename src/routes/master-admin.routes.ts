import { Router } from 'express';
import { db } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { EmailVerificationService } from '../services/email-verification.service';
import { decryptSettingSecret, encryptSettingSecret } from '../utils/secret.util';

const router = Router();
const ALLOWED_PLANS = ['Starter Store', 'Pro Store', 'Enterprise Store'];

function addMonths(dateValue: string, months: number): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, 1));
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function calculateDurationMonths(startsAt: string, endsAt: string): number {
  const [startYear, startMonth, startDay] = startsAt.split('-').map(Number);
  const [endYear, endMonth, endDay] = endsAt.split('-').map(Number);
  let months = ((endYear - startYear) * 12) + (endMonth - startMonth);
  if (endDay > startDay) months += 1;
  return Math.max(1, months);
}

// MASTER ADMIN API ENDPOINTS (/api/master-admin/*)
// Strictly enforced with AuthMiddleware.requireMasterAdmin
// ==========================================

// GET /api/master-admin/dashboard
router.get('/api/master-admin/dashboard', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const totalMerchants = (db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get() as any).count;
    const activeStores = (db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.status = 'active' AND s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get() as any).count;
    const pendingApplications = (db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'pending'").get() as any).count;
    const suspendedStores = (db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.status = 'suspended' AND s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get() as any).count;
    const totalUsers = (db.prepare("SELECT COUNT(*) as count FROM users WHERE id = 1 OR email_verified_at IS NOT NULL").get() as any).count;
    const totalOrders = (db.prepare("SELECT COUNT(*) as count FROM orders").get() as any).count;
    const totalAiMessages = (db.prepare("SELECT COUNT(*) as count FROM ai_usage").get() as any).count;
    const activeSubscriptions = (db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'approved' OR status = 'active'").get() as any).count;

    const recentApplications = db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC LIMIT 5").all();
    const recentMerchants = db.prepare(`
      SELECT s.id as store_id, s.name as store_name, s.slug, s.status as store_status, u.full_name as owner_name, u.email as owner_email, s.created_at
      FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
      ORDER BY s.id DESC LIMIT 5
    `).all();

    return res.json({
      success: true,
      metrics: {
        totalMerchants,
        activeStores,
        pendingApplications,
        suspendedStores,
        totalUsers,
        totalOrders,
        totalAiMessages,
        activeSubscriptions
      },
      recentApplications,
      recentMerchants
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/merchants
router.get('/api/master-admin/merchants', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const status = String(req.query.status || 'all').trim().toLowerCase();

    let query = `
      SELECT s.id as store_id, s.name as store_name, s.slug as store_slug, s.status as store_status, s.created_at as store_created_at,
             u.id as owner_id, u.full_name as owner_name, u.email as owner_email, u.phone as owner_phone, u.status as user_status,
             u.email_verified_at, u.created_at as user_created_at,
             m.role as owner_role, m.status as membership_status,
             ma.status as application_status,
             COALESCE(ss.plan_name, ma.plan) as plan,
             ss.starts_at as plan_starts_at, ss.ends_at as plan_ends_at
      FROM stores s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN memberships m ON m.user_id = u.id AND m.store_id = s.id
      LEFT JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      LEFT JOIN store_subscriptions ss ON ss.store_id = s.id
      WHERE s.id != 1
        AND u.email_verified_at IS NOT NULL
        AND ma.status IN ('approved', 'active')
    `;

    const params: any[] = [];

    if (status !== 'all') {
      query += ` AND (LOWER(s.status) = ? OR LOWER(m.status) = ?)`;
      params.push(status, status);
    }

    if (search) {
      query += ` AND (LOWER(s.name) LIKE ? OR LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR u.phone LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    query += ` ORDER BY s.id DESC`;

    const merchants = db.prepare(query).all(...params);
    return res.json({ success: true, merchants });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/merchants/:storeId
router.get('/api/master-admin/merchants/:storeId', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (!targetStoreId || isNaN(targetStoreId)) {
      return res.status(400).json({ success: false, error: 'Geçersiz mağaza ID.' });
    }

    const store = db.prepare(`
      SELECT s.id, s.owner_id, s.name, s.slug, s.status, s.created_at, s.updated_at
      FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id = ? AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    const owner = db.prepare(`
      SELECT id, full_name, email, phone, status, email_verified_at, created_at
      FROM users WHERE id = ?
    `).get(store.owner_id) as any;
    const membership = db.prepare(`
      SELECT id, role, status, created_at
      FROM memberships WHERE user_id = ? AND store_id = ?
    `).get(store.owner_id, targetStoreId) as any;
    const application = db.prepare(`
      SELECT id, store_name, plan, status, created_at, updated_at
      FROM merchant_applications WHERE LOWER(email) = LOWER(?)
    `).get(owner?.email || '') as any;
    const subscription = db.prepare(`
      SELECT plan_name, duration_months, starts_at, ends_at, created_at, updated_at,
             CAST(julianday(ends_at) - julianday(date('now')) AS INTEGER) AS remaining_days
      FROM store_subscriptions WHERE store_id = ?
    `).get(targetStoreId) as any;

    const productsCount = (db.prepare("SELECT COUNT(*) as count FROM products WHERE store_id = ?").get(targetStoreId) as any).count;
    const ordersCount = (db.prepare("SELECT COUNT(*) as count FROM orders WHERE store_id = ?").get(targetStoreId) as any).count;
    const customersCount = (db.prepare("SELECT COUNT(*) as count FROM customers WHERE store_id = ?").get(targetStoreId) as any).count;
    const campaignsCount = (db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE store_id = ?").get(targetStoreId) as any).count;
    const rewardsCount = (db.prepare("SELECT COUNT(*) as count FROM user_rewards WHERE store_id = ?").get(targetStoreId) as any).count;
    const aiUsageCount = (db.prepare("SELECT COUNT(*) as count FROM ai_usage WHERE store_id = ?").get(targetStoreId) as any).count;
    const apiKeysCount = (db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE store_id = ?").get(targetStoreId) as any).count;

    const aiSettingRows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('ai_provider', 'ai_api_key', 'openai_api_key', 'gemini_api_key')
    `).all(targetStoreId) as Array<{ key: string; value: string }>;
    const aiSettings = Object.fromEntries(aiSettingRows.map(row => [row.key, String(row.value || '')]));
    const aiProvider = aiSettings.ai_provider === 'gemini' ? 'gemini' : 'openai';
    const legacyAiKey = decryptSettingSecret(aiSettings.ai_api_key || '').trim();
    const openAiConfigured = Boolean(decryptSettingSecret(aiSettings.openai_api_key || '').trim()) || (aiProvider === 'openai' && Boolean(legacyAiKey));
    const geminiConfigured = Boolean(decryptSettingSecret(aiSettings.gemini_api_key || '').trim()) || (aiProvider === 'gemini' && Boolean(legacyAiKey));

    const recentProducts = db.prepare("SELECT product_code, name, price, stock FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 5").all(targetStoreId);
    const recentOrders = db.prepare(`
      SELECT id,
             TRIM(first_name || ' ' || COALESCE(last_name, '')) AS customer_name,
             total_price, status, created_at
      FROM orders
      WHERE store_id = ?
      ORDER BY id DESC
      LIMIT 5
    `).all(targetStoreId);
    const recentAuditLogs = db.prepare("SELECT id, action, entity_type, entity_id, created_at FROM audit_logs WHERE store_id = ? ORDER BY id DESC LIMIT 10").all(targetStoreId);

    AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_VIEW_MERCHANT', 'stores', String(targetStoreId));

    return res.json({
      success: true,
      detail: {
        store,
        owner,
        membership,
        application,
        subscription,
        aiSettings: {
          provider: aiProvider,
          openaiConfigured: openAiConfigured,
          geminiConfigured: geminiConfigured
        },
        metrics: {
          productsCount,
          ordersCount,
          customersCount,
          campaignsCount,
          rewardsCount,
          aiUsageCount,
          apiKeysCount
        },
        recentProducts,
        recentOrders,
        recentAuditLogs
      }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/ai-settings
router.post('/api/master-admin/stores/:storeId/ai-settings', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (!Number.isInteger(targetStoreId) || targetStoreId <= 0) {
      return res.status(400).json({ success: false, error: 'Geçersiz mağaza ID.' });
    }
    const store = db.prepare('SELECT id, name FROM stores WHERE id = ?').get(targetStoreId) as { id: number; name: string } | undefined;
    if (!store) return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });

    const provider = req.body?.provider === 'gemini' ? 'gemini' : req.body?.provider === 'openai' ? 'openai' : null;
    if (!provider) return res.status(400).json({ success: false, error: 'OpenAI veya Gemini sağlayıcısını seçiniz.' });

    const openaiApiKey = typeof req.body?.openaiApiKey === 'string' ? req.body.openaiApiKey.trim() : '';
    const geminiApiKey = typeof req.body?.geminiApiKey === 'string' ? req.body.geminiApiKey.trim() : '';
    const clearOpenaiApiKey = req.body?.clearOpenaiApiKey === true;
    const clearGeminiApiKey = req.body?.clearGeminiApiKey === true;

    for (const key of [openaiApiKey, geminiApiKey]) {
      if (key && (key.length < 20 || key.length > 512)) {
        return res.status(400).json({ success: false, error: 'API anahtarı geçerli uzunlukta değil.' });
      }
    }
    if (openaiApiKey && /^(?:AIza[A-Za-z0-9_-]+|AQ\.[A-Za-z0-9._-]+)$/.test(openaiApiKey)) {
      return res.status(400).json({ success: false, error: 'OpenAI alanına Google Gemini anahtarı girilemez.' });
    }
    if (geminiApiKey && /^sk-[A-Za-z0-9_-]+$/.test(geminiApiKey)) {
      return res.status(400).json({ success: false, error: 'Gemini alanına OpenAI anahtarı girilemez.' });
    }

    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('ai_provider', 'ai_api_key', 'openai_api_key', 'gemini_api_key')
    `).all(targetStoreId) as Array<{ key: string; value: string }>;
    const current = Object.fromEntries(rows.map(row => [row.key, String(row.value || '')]));
    const currentProvider = current.ai_provider === 'gemini' ? 'gemini' : 'openai';
    const legacyKey = decryptSettingSecret(current.ai_api_key || '').trim();
    const savedOpenaiKey = decryptSettingSecret(current.openai_api_key || '').trim() || (currentProvider === 'openai' ? legacyKey : '');
    const savedGeminiKey = decryptSettingSecret(current.gemini_api_key || '').trim() || (currentProvider === 'gemini' ? legacyKey : '');
    const projectedOpenaiKey = openaiApiKey || (clearOpenaiApiKey ? '' : savedOpenaiKey);
    const projectedGeminiKey = geminiApiKey || (clearGeminiApiKey ? '' : savedGeminiKey);
    if ((provider === 'openai' && !projectedOpenaiKey) || (provider === 'gemini' && !projectedGeminiKey)) {
      return res.status(400).json({ success: false, error: 'Aktif sağlayıcı için API anahtarı zorunludur.' });
    }

    const saveSetting = db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)');
    db.transaction(() => {
      saveSetting.run(targetStoreId, 'ai_provider', provider);
      if (projectedOpenaiKey) saveSetting.run(targetStoreId, 'openai_api_key', encryptSettingSecret(projectedOpenaiKey));
      else db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'openai_api_key'").run(targetStoreId);
      if (projectedGeminiKey) saveSetting.run(targetStoreId, 'gemini_api_key', encryptSettingSecret(projectedGeminiKey));
      else db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'gemini_api_key'").run(targetStoreId);
      db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'ai_api_key'").run(targetStoreId);
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_UPDATE_STORE_AI', 'stores', String(targetStoreId));
    })();

    return res.json({
      success: true,
      message: `${store.name} mağazasının yapay zeka API ayarları güncellendi.`,
      aiSettings: {
        provider,
        openaiConfigured: Boolean(projectedOpenaiKey),
        geminiConfigured: Boolean(projectedGeminiKey)
      }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Yapay zeka API ayarları güncellenemedi.' });
  }
});

// GET /api/master-admin/applications
router.get('/api/master-admin/applications', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const apps = db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC").all();
    return res.json({ success: true, applications: apps });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/applications/:id/approve
router.post('/api/master-admin/applications/:id/approve', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const appId = Number(req.params.id);
    const appRow = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId) as any;
    if (!appRow) {
      return res.status(404).json({ success: false, error: 'Mağaza başvurusu bulunamadı.' });
    }

    const verifiedUser = db.prepare('SELECT email_verified_at FROM users WHERE LOWER(email) = LOWER(?)').get(appRow.email) as any;
    if (!verifiedUser?.email_verified_at) {
      return res.status(409).json({ success: false, error: 'E-posta adresi doğrulanmadan bu başvuru onaylanamaz.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE merchant_applications SET status = \'approved\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
      db.prepare('UPDATE users SET status = \'active\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
      
      const userRow = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase()) as any;
      if (userRow) {
        db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
        db.prepare('UPDATE memberships SET status = \'active\' WHERE user_id = ?').run(userRow.id);
        db.prepare(`
          INSERT OR IGNORE INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at, updated_by)
          SELECT id, ?, 1, date('now'), date('now', '+1 month'), ? FROM stores WHERE owner_id = ?
        `).run(appRow.plan || 'Pro Store', req.auth!.userId, userRow.id);
      }

      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_APPROVE_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
    })();

    let notificationSent = true;
    try {
      await EmailVerificationService.sendAccountApprovedEmail({ email: appRow.email, fullName: appRow.full_name, storeName: appRow.store_name });
    } catch (emailError: any) {
      notificationSent = false;
      console.error('[Account Approval Email] Send failed:', emailError?.response?.data || emailError?.message || emailError);
    }

    return res.json({ success: true, notificationSent, message: notificationSent ? `${appRow.store_name} mağaza başvurusu onaylandı ve kullanıcıya e-posta gönderildi.` : `${appRow.store_name} mağaza başvurusu onaylandı; bildirim e-postası gönderilemedi.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/applications/:id/reject
router.post('/api/master-admin/applications/:id/reject', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const appId = Number(req.params.id);
    const appRow = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId) as any;
    if (!appRow) {
      return res.status(404).json({ success: false, error: 'Mağaza başvurusu bulunamadı.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE merchant_applications SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
      db.prepare('UPDATE users SET status = \'rejected\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
      
      const userRow = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase()) as any;
      if (userRow) {
        db.prepare('UPDATE stores SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
        db.prepare('UPDATE memberships SET status = \'rejected\' WHERE user_id = ?').run(userRow.id);
      }

      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_REJECT_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
    })();

    return res.json({ success: true, message: `${appRow.store_name} mağaza başvurusu reddedildi.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/suspend
router.post('/api/master-admin/stores/:storeId/suspend', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (targetStoreId === 1) {
      return res.status(400).json({ success: false, error: 'Master Admin mağazası askıya alınamaz.' });
    }

    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE stores SET status = \'suspended\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
      db.prepare('UPDATE memberships SET status = \'suspended\' WHERE store_id = ?').run(targetStoreId);
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_SUSPEND_STORE', 'stores', String(targetStoreId), store.status, 'suspended');
    })();

    return res.json({ success: true, message: `${store.name} mağazası başarıyla askıya alındı.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/activate
router.post('/api/master-admin/stores/:storeId/activate', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
      db.prepare('UPDATE memberships SET status = \'active\' WHERE store_id = ?').run(targetStoreId);
      db.prepare('UPDATE users SET status = \'active\' WHERE id = ?').run(store.owner_id);
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_ACTIVATE_STORE', 'stores', String(targetStoreId), store.status, 'active');
    })();

    return res.json({ success: true, message: `${store.name} mağazası yeniden aktifleştirildi!` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/change-plan
router.post('/api/master-admin/stores/:storeId/change-plan', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (targetStoreId === 1) {
      return res.status(400).json({ success: false, error: 'Master Admin store plan cannot be changed.' });
    }

    const plan = String(req.body?.plan || '').trim();
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, error: 'Yeni paket adı zorunludur.' });
    }

    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(store.owner_id) as any;
    if (owner) {
      db.prepare('UPDATE merchant_applications SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = ?').run(plan, owner.email.toLowerCase());
    }
    db.prepare('UPDATE store_subscriptions SET plan_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ?').run(plan, req.auth!.userId, targetStoreId);

    AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_CHANGE_PLAN', 'stores', String(targetStoreId), '', String(plan));

    return res.json({ success: true, message: `${store.name} mağazasının paketi "${plan}" olarak güncellendi.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/plans
router.get('/api/master-admin/plans', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const subscriptions = db.prepare(`
      SELECT s.id AS store_id, s.name AS store_name, s.status AS store_status,
             u.full_name AS owner_name, u.email AS owner_email,
             COALESCE(ss.plan_name, ma.plan, 'Pro Store') AS plan_name,
             ss.duration_months, ss.starts_at, ss.ends_at, ss.updated_at,
             CAST(julianday(ss.ends_at) - julianday(ss.starts_at) AS INTEGER) AS duration_days,
             CAST(julianday(ss.ends_at) - julianday(date('now')) AS INTEGER) AS remaining_days,
             (SELECT COUNT(*) FROM plan_support_requests psr WHERE psr.store_id = s.id AND psr.status = 'open') AS open_request_count
      FROM stores s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      LEFT JOIN store_subscriptions ss ON ss.store_id = s.id
      WHERE s.id != 1
        AND u.email_verified_at IS NOT NULL
        AND ma.status IN ('approved', 'active')
      ORDER BY s.id DESC
    `).all();

    const requests = db.prepare(`
      SELECT psr.id, psr.store_id, s.name AS store_name, u.full_name AS requester_name,
             psr.current_plan, psr.requested_plan, psr.message, psr.status,
             psr.admin_note, psr.created_at, psr.resolved_at
      FROM plan_support_requests psr
      JOIN stores s ON s.id = psr.store_id
      JOIN users u ON u.id = psr.user_id
      ORDER BY CASE psr.status WHEN 'open' THEN 0 ELSE 1 END, psr.id DESC
      LIMIT 100
    `).all();

    return res.json({ success: true, subscriptions, requests, allowedPlans: ALLOWED_PLANS });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/master-admin/stores/:storeId/subscription
router.put('/api/master-admin/stores/:storeId/subscription', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const storeId = Number(req.params.storeId);
    const planName = String(req.body?.planName || '').trim();
    const requestedDurationMonths = Number(req.body?.durationMonths);
    const startsAt = String(req.body?.startsAt || '').trim();
    const requestedEndsAt = String(req.body?.endsAt || '').trim();

    if (!storeId || storeId === 1) return res.status(400).json({ success: false, error: 'Geçersiz mağaza.' });
    if (!ALLOWED_PLANS.includes(planName)) return res.status(400).json({ success: false, error: 'Geçerli bir plan seçin.' });
    if (!isValidDateOnly(startsAt)) {
      return res.status(400).json({ success: false, error: 'Geçerli bir başlangıç tarihi girin.' });
    }

    let endsAt = requestedEndsAt;
    if (endsAt) {
      if (!isValidDateOnly(endsAt)) return res.status(400).json({ success: false, error: 'Geçerli bir bitiş tarihi girin.' });
      if (endsAt <= startsAt) return res.status(400).json({ success: false, error: 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.' });
    } else {
      if (!Number.isInteger(requestedDurationMonths) || requestedDurationMonths < 1 || requestedDurationMonths > 60) {
        return res.status(400).json({ success: false, error: 'Plan süresi veya bitiş tarihi geçerli olmalıdır.' });
      }
      endsAt = addMonths(startsAt, requestedDurationMonths);
    }

    const durationMonths = calculateDurationMonths(startsAt, endsAt);
    if (durationMonths > 60 || endsAt > addMonths(startsAt, 60)) {
      return res.status(400).json({ success: false, error: 'Plan dönemi en fazla 60 ay olabilir.' });
    }

    const store = db.prepare('SELECT id, name, owner_id FROM stores WHERE id = ?').get(storeId) as any;
    if (!store) return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    db.transaction(() => {
      db.prepare(`
        INSERT INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_id) DO UPDATE SET
          plan_name = excluded.plan_name,
          duration_months = excluded.duration_months,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(storeId, planName, durationMonths, startsAt, endsAt, req.auth!.userId);

      const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(store.owner_id) as any;
      if (owner?.email) {
        db.prepare('UPDATE merchant_applications SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?)').run(planName, owner.email);
      }
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_UPDATE_SUBSCRIPTION', 'store_subscriptions', String(storeId), '', `${planName}|${startsAt}|${endsAt}`);
    })();

    const durationDays = Math.round((Date.parse(`${endsAt}T00:00:00Z`) - Date.parse(`${startsAt}T00:00:00Z`)) / 86_400_000);
    return res.json({ success: true, message: `${store.name} plan dönemi ${startsAt} – ${endsAt} olarak kaydedildi.`, subscription: { storeId, planName, durationMonths, durationDays, startsAt, endsAt } });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/master-admin/plan-support-requests/:id/status
router.post('/api/master-admin/plan-support-requests/:id/status', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const requestId = Number(req.params.id);
    const status = String(req.body?.status || '').trim();
    const adminNote = String(req.body?.adminNote || '').trim().slice(0, 1000);
    if (!['resolved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Geçerli bir talep durumu seçin.' });
    }
    if (adminNote.length < 3) return res.status(400).json({ success: false, error: 'Müşteriye gösterilecek yanıt en az 3 karakter olmalıdır.' });
    const request = db.prepare(`
      SELECT psr.*, u.email, u.full_name, s.name AS store_name
      FROM plan_support_requests psr
      JOIN users u ON u.id = psr.user_id
      JOIN stores s ON s.id = psr.store_id
      WHERE psr.id = ?
    `).get(requestId) as any;
    if (!request) return res.status(404).json({ success: false, error: 'Destek talebi bulunamadı.' });
    if (request.status !== 'open') return res.status(409).json({ success: false, error: 'Bu destek talebi daha önce sonuçlandırılmış.' });

    db.prepare(`
      UPDATE plan_support_requests
      SET status = ?, admin_note = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, adminNote, req.auth!.userId, requestId);
    AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_RESOLVE_PLAN_REQUEST', 'plan_support_requests', String(requestId), request.status, status);
    let notificationSent = true;
    try {
      await EmailVerificationService.sendPlanSupportResponseEmail({
        email: request.email,
        fullName: request.full_name,
        storeName: request.store_name,
        requestedPlan: request.requested_plan,
        adminNote,
        resolved: status === 'resolved',
        requestId
      });
    } catch (emailError: any) {
      notificationSent = false;
      console.error('[Plan Support Email] Send failed:', emailError?.response?.data || emailError?.message || emailError);
    }
    return res.json({ success: true, notificationSent, message: status === 'resolved' ? 'Destek talebi çözüldü.' : 'Destek talebi reddedildi.' });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. PROTECTED MERCHANT API ENDPOINTS (Authenticated & Scoped by req.auth.storeId)
// ==========================================


export default router;
