"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const webhook_controller_1 = require("../controllers/webhook.controller");
const db_1 = require("../database/db");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
// 2. WEBHOOK ENDPOINTS (Stage 5 Security Rules)
// ==========================================
router.get('/webhook/instagram', webhook_controller_1.WebhookController.verifyWebhook);
router.post('/webhook/instagram', webhook_controller_1.WebhookController.handleWebhook);
router.get('/api/webhook/:storeSlug', webhook_controller_1.WebhookController.verifyStoreWebhook);
router.post('/api/webhook/:storeSlug', webhook_controller_1.WebhookController.handleStoreWebhook);
// GET /api/integration/status (Authenticated Merchant - Scoped by req.auth.storeId)
router.get('/api/integration/status', auth_middleware_1.AuthMiddleware.authenticate, (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const store = db_1.db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at FROM stores WHERE id = ?').get(storeId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃ„Å¸aza bulunamadÃ„Â±.' });
        }
        const isConnected = !!(store.meta_page_id || store.instagram_account_id);
        const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhook/${store.slug}`;
        return res.json({
            success: true,
            storeId: store.id,
            storeName: store.name,
            storeSlug: store.slug,
            metaPageId: store.meta_page_id || '',
            instagramAccountId: store.instagram_account_id || '',
            instagramUsername: store.instagram_username || '',
            connected: isConnected,
            webhookUrl,
            globalWebhookUrl: `${req.protocol}://${req.get('host')}/webhook/instagram`,
            lastWebhookAt: store.last_webhook_at || null
        });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/integration/meta (Authenticated Merchant - Scoped by req.auth.storeId)
router.post('/api/integration/meta', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { metaPageId, instagramAccountId, instagramUsername } = req.body || {};
        db_1.db.prepare(`
      UPDATE stores 
      SET meta_page_id = ?, instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(metaPageId || '').trim(), String(instagramAccountId || '').trim(), String(instagramUsername || '').trim(), storeId);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'UPDATE_META_INTEGRATION', 'stores', String(storeId));
        return res.json({ success: true, message: 'Meta / Instagram entegrasyon bilgileri baÃ…Å¸arÃ„Â±yla gÃƒÂ¼ncellendi.' });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
exports.default = router;
