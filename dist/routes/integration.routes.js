"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const webhook_controller_1 = require("../controllers/webhook.controller");
const db_1 = require("../database/db");
const auth_middleware_1 = require("../middleware/auth.middleware");
const env_1 = require("../config/env");
const router = (0, express_1.Router)();
const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
function encryptToken(token) {
    const key = crypto_1.default.createHash('sha256').update(`${env_1.env.jwtSecret}:instagram-token-v1`).digest();
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}
function htmlResponse(title, message, success = false) {
    const color = success ? '#16a34a' : '#dc2626';
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:Arial,sans-serif;padding:48px;text-align:center"><h1 style="color:${color}">${title}</h1><p>${message}</p><p>Bu pencereyi kapatıp mağaza paneline dönebilirsiniz.</p><script>if (window.opener) window.opener.postMessage({type:'instagram-oauth-complete',success:${success}}, window.location.origin);</script></body></html>`;
}
// 2. WEBHOOK ENDPOINTS (Stage 5 Security Rules)
// ==========================================
router.get('/webhook/instagram', webhook_controller_1.WebhookController.verifyWebhook);
router.post('/webhook/instagram', webhook_controller_1.WebhookController.handleWebhook);
router.get('/api/webhook/:storeSlug', webhook_controller_1.WebhookController.verifyStoreWebhook);
router.post('/api/webhook/:storeSlug', webhook_controller_1.WebhookController.handleStoreWebhook);
router.post('/api/integrations/instagram/connect', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    if (!env_1.env.instagramAppId || !env_1.env.instagramAppSecret || !env_1.env.instagramOauthRedirectUri) {
        return res.status(503).json({ success: false, error: 'Instagram OAuth yapılandırması sunucuda tamamlanmamış.' });
    }
    const state = crypto_1.default.randomBytes(32).toString('base64url');
    const stateHash = crypto_1.default.createHash('sha256').update(state).digest('hex');
    db_1.db.prepare('DELETE FROM instagram_oauth_states WHERE expires_at <= CURRENT_TIMESTAMP').run();
    db_1.db.prepare(`
    INSERT INTO instagram_oauth_states (state_hash, store_id, user_id, expires_at)
    VALUES (?, ?, ?, datetime('now', '+10 minutes'))
  `).run(stateHash, req.auth.storeId, req.auth.userId);
    const authorizeUrl = new URL('https://www.instagram.com/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', env_1.env.instagramAppId);
    authorizeUrl.searchParams.set('redirect_uri', env_1.env.instagramOauthRedirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
    authorizeUrl.searchParams.set('state', state);
    return res.json({ success: true, authorizeUrl: authorizeUrl.toString() });
});
router.get('/api/integrations/instagram/callback', async (req, res) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const error = String(req.query.error || '');
    if (error || !code || !state) {
        return res.status(400).send(htmlResponse('Instagram bağlantısı tamamlanamadı', error || 'Meta yetkilendirme bilgisi eksik.'));
    }
    const stateHash = crypto_1.default.createHash('sha256').update(state).digest('hex');
    const oauthState = db_1.db.prepare(`
    SELECT state_hash, store_id, user_id FROM instagram_oauth_states
    WHERE state_hash = ? AND expires_at > CURRENT_TIMESTAMP
  `).get(stateHash);
    db_1.db.prepare('DELETE FROM instagram_oauth_states WHERE state_hash = ?').run(stateHash);
    if (!oauthState || !env_1.env.instagramAppId || !env_1.env.instagramAppSecret || !env_1.env.instagramOauthRedirectUri) {
        return res.status(400).send(htmlResponse('Instagram bağlantısı tamamlanamadı', 'Bağlantı isteği geçersiz veya süresi dolmuş. Lütfen yeniden deneyin.'));
    }
    try {
        const tokenForm = new URLSearchParams({
            client_id: env_1.env.instagramAppId,
            client_secret: env_1.env.instagramAppSecret,
            grant_type: 'authorization_code',
            redirect_uri: env_1.env.instagramOauthRedirectUri,
            code
        });
        const tokenResponse = await axios_1.default.post('https://api.instagram.com/oauth/access_token', tokenForm, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000
        });
        let accessToken = String(tokenResponse.data?.access_token || '');
        const instagramUserId = String(tokenResponse.data?.user_id || '');
        if (!accessToken || !instagramUserId)
            throw new Error('Meta geçerli bir Instagram erişim anahtarı döndürmedi.');
        try {
            const longLived = await axios_1.default.get('https://graph.instagram.com/access_token', {
                params: { grant_type: 'ig_exchange_token', client_secret: env_1.env.instagramAppSecret, access_token: accessToken }, timeout: 15_000
            });
            accessToken = String(longLived.data?.access_token || accessToken);
        }
        catch {
            // Short-lived token remains usable; a later refresh job can upgrade it.
        }
        const profile = await axios_1.default.get('https://graph.instagram.com/v24.0/me', {
            params: { fields: 'user_id,username', access_token: accessToken }, timeout: 15_000
        });
        const resolvedInstagramId = String(profile.data?.user_id || instagramUserId);
        const username = String(profile.data?.username || '').trim();
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE stores SET instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(resolvedInstagramId, username, oauthState.store_id);
            db_1.db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)')
                .run(oauthState.store_id, 'instagram_access_token', encryptToken(accessToken));
            auth_middleware_1.AuthMiddleware.logAudit(oauthState.store_id, oauthState.user_id, 'CONNECT_INSTAGRAM', 'stores', String(oauthState.store_id));
        })();
        return res.send(htmlResponse('Instagram bağlandı', username ? `@${username} hesabı mağazanıza bağlandı.` : 'Instagram hesabı mağazanıza bağlandı.', true));
    }
    catch (error) {
        console.error('[Instagram OAuth] Callback failed:', error.response?.data || error.message);
        return res.status(502).send(htmlResponse('Instagram bağlantısı tamamlanamadı', 'Meta erişim anahtarı alınamadı. Uygulama izinlerini ve yönlendirme adresini kontrol edin.'));
    }
});
router.post('/api/integrations/instagram/disconnect', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    const storeId = req.auth.storeId;
    db_1.db.transaction(() => {
        db_1.db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").run(storeId);
        db_1.db.prepare('UPDATE stores SET instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', '', storeId);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'DISCONNECT_INSTAGRAM', 'stores', String(storeId));
    })();
    return res.json({ success: true });
});
// GET /api/integration/status (Authenticated Merchant - Scoped by req.auth.storeId)
router.get('/api/integration/status', auth_middleware_1.AuthMiddleware.authenticate, (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const store = db_1.db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at FROM stores WHERE id = ?').get(storeId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃ„Å¸aza bulunamadÃ„Â±.' });
        }
        const hasInstagramToken = !!db_1.db.prepare("SELECT 1 FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").get(storeId);
        const isConnected = !!store.instagram_account_id && hasInstagramToken;
        const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhook/${store.slug}`;
        return res.json({
            success: true,
            storeId: store.id,
            storeName: store.name,
            storeSlug: store.slug,
            metaPageId: store.meta_page_id || '',
            instagramAccountId: store.instagram_account_id || '',
            instagramUsername: store.instagram_username || '',
            instagramConnected: isConnected,
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
