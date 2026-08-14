"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../database/db");
const auth_middleware_1 = require("../middleware/auth.middleware");
const email_verification_service_1 = require("../services/email-verification.service");
const router = (0, express_1.Router)();
const ALLOWED_PLANS = ['Starter Store', 'Pro Store', 'Enterprise Store'];
function addMonths(dateValue, months) {
    const [year, month, day] = dateValue.split('-').map(Number);
    const target = new Date(Date.UTC(year, month - 1, 1));
    target.setUTCMonth(target.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
}
function isValidDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function calculateDurationMonths(startsAt, endsAt) {
    const [startYear, startMonth, startDay] = startsAt.split('-').map(Number);
    const [endYear, endMonth, endDay] = endsAt.split('-').map(Number);
    let months = ((endYear - startYear) * 12) + (endMonth - startMonth);
    if (endDay > startDay)
        months += 1;
    return Math.max(1, months);
}
// MASTER ADMIN API ENDPOINTS (/api/master-admin/*)
// Strictly enforced with AuthMiddleware.requireMasterAdmin
// ==========================================
// GET /api/master-admin/dashboard
router.get('/api/master-admin/dashboard', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const totalMerchants = db_1.db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get().count;
        const activeStores = db_1.db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.status = 'active' AND s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get().count;
        const pendingApplications = db_1.db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'pending'").get().count;
        const suspendedStores = db_1.db.prepare(`
      SELECT COUNT(*) AS count FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.status = 'suspended' AND s.id != 1 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get().count;
        const totalUsers = db_1.db.prepare("SELECT COUNT(*) as count FROM users WHERE id = 1 OR email_verified_at IS NOT NULL").get().count;
        const totalOrders = db_1.db.prepare("SELECT COUNT(*) as count FROM orders").get().count;
        const totalAiMessages = db_1.db.prepare("SELECT COUNT(*) as count FROM ai_usage").get().count;
        const activeSubscriptions = db_1.db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'approved' OR status = 'active'").get().count;
        const recentApplications = db_1.db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC LIMIT 5").all();
        const recentMerchants = db_1.db.prepare(`
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
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// GET /api/master-admin/merchants
router.get('/api/master-admin/merchants', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const search = String(req.query.search || '').trim().toLowerCase();
        const status = String(req.query.status || 'all').trim().toLowerCase();
        let query = `
      SELECT s.id as store_id, s.name as store_name, s.slug as store_slug, s.status as store_status, s.created_at as store_created_at,
             u.id as owner_id, u.full_name as owner_name, u.email as owner_email, u.phone as owner_phone, u.status as user_status,
             m.role as owner_role, m.status as membership_status,
             ma.plan as plan
      FROM stores s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN memberships m ON m.user_id = u.id AND m.store_id = s.id
      LEFT JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id != 1
        AND u.email_verified_at IS NOT NULL
        AND ma.status IN ('approved', 'active')
    `;
        const params = [];
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
        const merchants = db_1.db.prepare(query).all(...params);
        return res.json({ success: true, merchants });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// GET /api/master-admin/merchants/:storeId
router.get('/api/master-admin/merchants/:storeId', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const targetStoreId = Number(req.params.storeId);
        if (!targetStoreId || isNaN(targetStoreId)) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz maÃƒâ€Ã…Â¸aza ID.' });
        }
        const store = db_1.db.prepare(`
      SELECT s.* FROM stores s
      JOIN users u ON u.id = s.owner_id
      JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id = ? AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
    `).get(targetStoreId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        const owner = db_1.db.prepare("SELECT id, full_name, email, phone, status, created_at FROM users WHERE id = ?").get(store.owner_id);
        const membership = db_1.db.prepare("SELECT * FROM memberships WHERE user_id = ? AND store_id = ?").get(store.owner_id, targetStoreId);
        const application = db_1.db.prepare("SELECT * FROM merchant_applications WHERE LOWER(email) = LOWER(?)").get(owner?.email || '');
        const productsCount = db_1.db.prepare("SELECT COUNT(*) as count FROM products WHERE store_id = ?").get(targetStoreId).count;
        const ordersCount = db_1.db.prepare("SELECT COUNT(*) as count FROM orders WHERE store_id = ?").get(targetStoreId).count;
        const customersCount = db_1.db.prepare("SELECT COUNT(*) as count FROM customers WHERE store_id = ?").get(targetStoreId).count;
        const campaignsCount = db_1.db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE store_id = ?").get(targetStoreId).count;
        const rewardsCount = db_1.db.prepare("SELECT COUNT(*) as count FROM user_rewards WHERE store_id = ?").get(targetStoreId).count;
        const aiUsageCount = db_1.db.prepare("SELECT COUNT(*) as count FROM ai_usage WHERE store_id = ?").get(targetStoreId).count;
        const apiKeysCount = db_1.db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE store_id = ?").get(targetStoreId).count;
        const recentProducts = db_1.db.prepare("SELECT product_code, name, price, stock FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 5").all(targetStoreId);
        const recentOrders = db_1.db.prepare(`
      SELECT id,
             TRIM(first_name || ' ' || COALESCE(last_name, '')) AS customer_name,
             total_price, status, created_at
      FROM orders
      WHERE store_id = ?
      ORDER BY id DESC
      LIMIT 5
    `).all(targetStoreId);
        const recentAuditLogs = db_1.db.prepare("SELECT id, action, entity_type, entity_id, created_at FROM audit_logs WHERE store_id = ? ORDER BY id DESC LIMIT 10").all(targetStoreId);
        auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_VIEW_MERCHANT', 'stores', String(targetStoreId));
        return res.json({
            success: true,
            detail: {
                store,
                owner,
                membership,
                application,
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
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// GET /api/master-admin/applications
router.get('/api/master-admin/applications', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const apps = db_1.db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC").all();
        return res.json({ success: true, applications: apps });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/applications/:id/approve
router.post('/api/master-admin/applications/:id/approve', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, async (req, res) => {
    try {
        const appId = Number(req.params.id);
        const appRow = db_1.db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId);
        if (!appRow) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
        }
        const verifiedUser = db_1.db.prepare('SELECT email_verified_at FROM users WHERE LOWER(email) = LOWER(?)').get(appRow.email);
        if (!verifiedUser?.email_verified_at) {
            return res.status(409).json({ success: false, error: 'E-posta adresi doğrulanmadan bu başvuru onaylanamaz.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE merchant_applications SET status = \'approved\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
            db_1.db.prepare('UPDATE users SET status = \'active\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
            const userRow = db_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase());
            if (userRow) {
                db_1.db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
                db_1.db.prepare('UPDATE memberships SET status = \'active\' WHERE user_id = ?').run(userRow.id);
                db_1.db.prepare(`
          INSERT OR IGNORE INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at, updated_by)
          SELECT id, ?, 1, date('now'), date('now', '+1 month'), ? FROM stores WHERE owner_id = ?
        `).run(appRow.plan || 'Pro Store', req.auth.userId, userRow.id);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_APPROVE_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
        })();
        let notificationSent = true;
        try {
            await email_verification_service_1.EmailVerificationService.sendAccountApprovedEmail({ email: appRow.email, fullName: appRow.full_name, storeName: appRow.store_name });
        }
        catch (emailError) {
            notificationSent = false;
            console.error('[Account Approval Email] Send failed:', emailError?.response?.data || emailError?.message || emailError);
        }
        return res.json({ success: true, notificationSent, message: notificationSent ? `${appRow.store_name} mağaza başvurusu onaylandı ve kullanıcıya e-posta gönderildi.` : `${appRow.store_name} mağaza başvurusu onaylandı; bildirim e-postası gönderilemedi.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/applications/:id/reject
router.post('/api/master-admin/applications/:id/reject', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const appId = Number(req.params.id);
        const appRow = db_1.db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId);
        if (!appRow) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE merchant_applications SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
            db_1.db.prepare('UPDATE users SET status = \'rejected\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
            const userRow = db_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase());
            if (userRow) {
                db_1.db.prepare('UPDATE stores SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
                db_1.db.prepare('UPDATE memberships SET status = \'rejected\' WHERE user_id = ?').run(userRow.id);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_REJECT_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
        })();
        return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu reddedildi.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/stores/:storeId/suspend
router.post('/api/master-admin/stores/:storeId/suspend', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const targetStoreId = Number(req.params.storeId);
        if (targetStoreId === 1) {
            return res.status(400).json({ success: false, error: 'Master Admin maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± askÃƒâ€Ã‚Â±ya alÃƒâ€Ã‚Â±namaz.' });
        }
        const store = db_1.db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE stores SET status = \'suspended\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
            db_1.db.prepare('UPDATE memberships SET status = \'suspended\' WHERE store_id = ?').run(targetStoreId);
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_SUSPEND_STORE', 'stores', String(targetStoreId), store.status, 'suspended');
        })();
        return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla askÃƒâ€Ã‚Â±ya alÃƒâ€Ã‚Â±ndÃƒâ€Ã‚Â±.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/stores/:storeId/activate
router.post('/api/master-admin/stores/:storeId/activate', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const targetStoreId = Number(req.params.storeId);
        const store = db_1.db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
            db_1.db.prepare('UPDATE memberships SET status = \'active\' WHERE store_id = ?').run(targetStoreId);
            db_1.db.prepare('UPDATE users SET status = \'active\' WHERE id = ?').run(store.owner_id);
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_ACTIVATE_STORE', 'stores', String(targetStoreId), store.status, 'active');
        })();
        return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± yeniden aktifleÃƒâ€¦Ã…Â¸tirildi!` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/stores/:storeId/change-plan
router.post('/api/master-admin/stores/:storeId/change-plan', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const targetStoreId = Number(req.params.storeId);
        if (targetStoreId === 1) {
            return res.status(400).json({ success: false, error: 'Master Admin store plan cannot be changed.' });
        }
        const plan = String(req.body?.plan || '').trim();
        if (!ALLOWED_PLANS.includes(plan)) {
            return res.status(400).json({ success: false, error: 'Yeni paket adÃƒâ€Ã‚Â± zorunludur.' });
        }
        const store = db_1.db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        const owner = db_1.db.prepare('SELECT email FROM users WHERE id = ?').get(store.owner_id);
        if (owner) {
            db_1.db.prepare('UPDATE merchant_applications SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = ?').run(plan, owner.email.toLowerCase());
        }
        db_1.db.prepare('UPDATE store_subscriptions SET plan_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ?').run(plan, req.auth.userId, targetStoreId);
        auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_CHANGE_PLAN', 'stores', String(targetStoreId), '', String(plan));
        return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±n paketi "${plan}" olarak gÃƒÆ’Ã‚Â¼ncellendi.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// GET /api/master-admin/plans
router.get('/api/master-admin/plans', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const subscriptions = db_1.db.prepare(`
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
        const requests = db_1.db.prepare(`
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
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// PUT /api/master-admin/stores/:storeId/subscription
router.put('/api/master-admin/stores/:storeId/subscription', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const storeId = Number(req.params.storeId);
        const planName = String(req.body?.planName || '').trim();
        const requestedDurationMonths = Number(req.body?.durationMonths);
        const startsAt = String(req.body?.startsAt || '').trim();
        const requestedEndsAt = String(req.body?.endsAt || '').trim();
        if (!storeId || storeId === 1)
            return res.status(400).json({ success: false, error: 'Geçersiz mağaza.' });
        if (!ALLOWED_PLANS.includes(planName))
            return res.status(400).json({ success: false, error: 'Geçerli bir plan seçin.' });
        if (!isValidDateOnly(startsAt)) {
            return res.status(400).json({ success: false, error: 'Geçerli bir başlangıç tarihi girin.' });
        }
        let endsAt = requestedEndsAt;
        if (endsAt) {
            if (!isValidDateOnly(endsAt))
                return res.status(400).json({ success: false, error: 'Geçerli bir bitiş tarihi girin.' });
            if (endsAt <= startsAt)
                return res.status(400).json({ success: false, error: 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.' });
        }
        else {
            if (!Number.isInteger(requestedDurationMonths) || requestedDurationMonths < 1 || requestedDurationMonths > 60) {
                return res.status(400).json({ success: false, error: 'Plan süresi veya bitiş tarihi geçerli olmalıdır.' });
            }
            endsAt = addMonths(startsAt, requestedDurationMonths);
        }
        const durationMonths = calculateDurationMonths(startsAt, endsAt);
        if (durationMonths > 60 || endsAt > addMonths(startsAt, 60)) {
            return res.status(400).json({ success: false, error: 'Plan dönemi en fazla 60 ay olabilir.' });
        }
        const store = db_1.db.prepare('SELECT id, name, owner_id FROM stores WHERE id = ?').get(storeId);
        if (!store)
            return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
        db_1.db.transaction(() => {
            db_1.db.prepare(`
        INSERT INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_id) DO UPDATE SET
          plan_name = excluded.plan_name,
          duration_months = excluded.duration_months,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(storeId, planName, durationMonths, startsAt, endsAt, req.auth.userId);
            const owner = db_1.db.prepare('SELECT email FROM users WHERE id = ?').get(store.owner_id);
            if (owner?.email) {
                db_1.db.prepare('UPDATE merchant_applications SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?)').run(planName, owner.email);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_UPDATE_SUBSCRIPTION', 'store_subscriptions', String(storeId), '', `${planName}|${startsAt}|${endsAt}`);
        })();
        const durationDays = Math.round((Date.parse(`${endsAt}T00:00:00Z`) - Date.parse(`${startsAt}T00:00:00Z`)) / 86_400_000);
        return res.json({ success: true, message: `${store.name} plan dönemi ${startsAt} – ${endsAt} olarak kaydedildi.`, subscription: { storeId, planName, durationMonths, durationDays, startsAt, endsAt } });
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// POST /api/master-admin/plan-support-requests/:id/status
router.post('/api/master-admin/plan-support-requests/:id/status', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const requestId = Number(req.params.id);
        const status = String(req.body?.status || '').trim();
        const adminNote = String(req.body?.adminNote || '').trim().slice(0, 1000);
        if (!['resolved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Geçerli bir talep durumu seçin.' });
        }
        if (adminNote.length < 3)
            return res.status(400).json({ success: false, error: 'Müşteriye gösterilecek yanıt en az 3 karakter olmalıdır.' });
        const request = db_1.db.prepare('SELECT * FROM plan_support_requests WHERE id = ?').get(requestId);
        if (!request)
            return res.status(404).json({ success: false, error: 'Destek talebi bulunamadı.' });
        if (request.status !== 'open')
            return res.status(409).json({ success: false, error: 'Bu destek talebi daha önce sonuçlandırılmış.' });
        db_1.db.prepare(`
      UPDATE plan_support_requests
      SET status = ?, admin_note = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, adminNote, req.auth.userId, requestId);
        auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_RESOLVE_PLAN_REQUEST', 'plan_support_requests', String(requestId), request.status, status);
        return res.json({ success: true, message: status === 'resolved' ? 'Destek talebi çözüldü.' : 'Destek talebi reddedildi.' });
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
// ==========================================
// 3. PROTECTED MERCHANT API ENDPOINTS (Authenticated & Scoped by req.auth.storeId)
// ==========================================
exports.default = router;
