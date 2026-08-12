"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../database/db");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
const ALLOWED_PLANS = ['Starter Store', 'Pro Store', 'Enterprise Store'];
// MASTER ADMIN API ENDPOINTS (/api/master-admin/*)
// Strictly enforced with AuthMiddleware.requireMasterAdmin
// ==========================================
// GET /api/master-admin/dashboard
router.get('/api/master-admin/dashboard', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const totalMerchants = db_1.db.prepare("SELECT COUNT(*) as count FROM stores WHERE id != 1").get().count;
        const activeStores = db_1.db.prepare("SELECT COUNT(*) as count FROM stores WHERE status = 'active' AND id != 1").get().count;
        const pendingApplications = db_1.db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'pending'").get().count;
        const suspendedStores = db_1.db.prepare("SELECT COUNT(*) as count FROM stores WHERE status = 'suspended'").get().count;
        const totalUsers = db_1.db.prepare("SELECT COUNT(*) as count FROM users").get().count;
        const totalOrders = db_1.db.prepare("SELECT COUNT(*) as count FROM orders").get().count;
        const totalAiMessages = db_1.db.prepare("SELECT COUNT(*) as count FROM ai_usage").get().count;
        const activeSubscriptions = db_1.db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'approved' OR status = 'active'").get().count;
        const recentApplications = db_1.db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications ORDER BY id DESC LIMIT 5").all();
        const recentMerchants = db_1.db.prepare(`
      SELECT s.id as store_id, s.name as store_name, s.slug, s.status as store_status, u.full_name as owner_name, u.email as owner_email, s.created_at
      FROM stores s
      JOIN users u ON u.id = s.owner_id
      WHERE s.id != 1
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
        const store = db_1.db.prepare("SELECT * FROM stores WHERE id = ?").get(targetStoreId);
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
        const recentOrders = db_1.db.prepare("SELECT id, customer_name, total_price, status, created_at FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 5").all(targetStoreId);
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
        const apps = db_1.db.prepare('SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications ORDER BY id DESC').all();
        return res.json({ success: true, applications: apps });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/master-admin/applications/:id/approve
router.post('/api/master-admin/applications/:id/approve', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireMasterAdmin, (req, res) => {
    try {
        const appId = Number(req.params.id);
        const appRow = db_1.db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId);
        if (!appRow) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE merchant_applications SET status = \'approved\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
            db_1.db.prepare('UPDATE users SET status = \'active\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
            const userRow = db_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase());
            if (userRow) {
                db_1.db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
                db_1.db.prepare('UPDATE memberships SET status = \'active\' WHERE user_id = ?').run(userRow.id);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_APPROVE_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
        })();
        return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla onaylandÃƒâ€Ã‚Â± ve aktifleÃƒâ€¦Ã…Â¸ti!` });
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
        auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'MASTER_ADMIN_CHANGE_PLAN', 'stores', String(targetStoreId), '', String(plan));
        return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±n paketi "${plan}" olarak gÃƒÆ’Ã‚Â¼ncellendi.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// ==========================================
// 3. PROTECTED MERCHANT API ENDPOINTS (Authenticated & Scoped by req.auth.storeId)
// ==========================================
exports.default = router;
