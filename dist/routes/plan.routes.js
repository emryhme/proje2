"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../database/db");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
const ALLOWED_PLANS = ['Starter Store', 'Pro Store', 'Enterprise Store'];
router.get('/api/plan', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const store = db_1.db.prepare('SELECT id, name FROM stores WHERE id = ?').get(storeId);
        const subscription = db_1.db.prepare(`
      SELECT store_id, plan_name, duration_months, starts_at, ends_at, updated_at,
             CAST(julianday(ends_at) - julianday(starts_at) AS INTEGER) AS duration_days,
             CAST(julianday(ends_at) - julianday(date('now')) AS INTEGER) AS remaining_days
      FROM store_subscriptions
      WHERE store_id = ?
    `).get(storeId);
        const requests = db_1.db.prepare(`
      SELECT id, current_plan, requested_plan, message, status, admin_note, created_at, updated_at, resolved_at
      FROM plan_support_requests
      WHERE store_id = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(storeId);
        return res.json({
            success: true,
            store,
            subscription: subscription || null,
            requests,
            allowedPlans: ALLOWED_PLANS
        });
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
router.post('/api/plan/support-requests', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const userId = req.auth.userId;
        const requestedPlan = String(req.body?.requestedPlan || '').trim();
        const message = String(req.body?.message || '').trim();
        if (!ALLOWED_PLANS.includes(requestedPlan)) {
            return res.status(400).json({ success: false, error: 'Geçerli bir plan seçin.' });
        }
        if (message.length < 10 || message.length > 1000) {
            return res.status(400).json({ success: false, error: 'Talep açıklaması 10 ile 1000 karakter arasında olmalıdır.' });
        }
        const subscription = db_1.db.prepare('SELECT plan_name FROM store_subscriptions WHERE store_id = ?').get(storeId);
        if (!subscription) {
            return res.status(404).json({ success: false, error: 'Mağazanız için aktif plan kaydı bulunamadı.' });
        }
        const openRequest = db_1.db.prepare("SELECT id FROM plan_support_requests WHERE store_id = ? AND status = 'open' LIMIT 1").get(storeId);
        if (openRequest) {
            return res.status(409).json({ success: false, error: 'Zaten değerlendirme bekleyen bir plan talebiniz var.' });
        }
        const result = db_1.db.prepare(`
      INSERT INTO plan_support_requests (store_id, user_id, current_plan, requested_plan, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(storeId, userId, subscription.plan_name, requestedPlan, message);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, userId, 'CREATE_PLAN_SUPPORT_REQUEST', 'plan_support_requests', String(result.lastInsertRowid), subscription.plan_name, requestedPlan);
        return res.status(201).json({ success: true, message: 'Plan değişikliği talebiniz destek ekibine iletildi.' });
    }
    catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});
exports.default = router;
