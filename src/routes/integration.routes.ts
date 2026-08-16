import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { WebhookController } from '../controllers/webhook.controller';
import { db } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';
import { env } from '../config/env';
import { FacebookService } from '../services/facebook.service';

const router = Router();

const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages'
];

function encryptToken(token: string): string {
  const key = crypto.createHash('sha256').update(`${env.jwtSecret}:instagram-token-v1`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}`;
}

function htmlResponse(title: string, message: string, success = false): string {
  const color = success ? '#16a34a' : '#dc2626';
  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;padding:48px;text-align:center"><h1 style="color:${color}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>Bu pencereyi kapatıp mağaza paneline dönebilirsiniz.</p><script>if (window.opener) window.opener.postMessage({type:'instagram-oauth-complete',success:${success}}, window.location.origin);</script></body></html>`;
}

type InstagramSignedRequest = { user_id?: string; [key: string]: unknown };

function parseInstagramSignedRequest(signedRequest: unknown): InstagramSignedRequest | null {
  if (!env.instagramAppSecret || typeof signedRequest !== 'string') return null;
  const [signatureText, payloadText] = signedRequest.split('.', 2);
  if (!signatureText || !payloadText) return null;

  try {
    const suppliedSignature = Buffer.from(signatureText, 'base64url');
    const expectedSignature = crypto.createHmac('sha256', env.instagramAppSecret).update(payloadText).digest();
    if (suppliedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8')) as InstagramSignedRequest;
    return typeof payload.user_id === 'string' && payload.user_id.trim() ? payload : null;
  } catch {
    return null;
  }
}

function disconnectInstagramAccount(instagramUserId: string): number | null {
  const store = db.prepare('SELECT id FROM stores WHERE instagram_account_id = ?').get(instagramUserId) as { id: number } | undefined;
  if (!store) return null;

  db.transaction(() => {
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").run(store.id);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_webhook_subscribed_at'").run(store.id);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_access_enabled'").run(store.id);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_permission_granted'").run(store.id);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_automation_enabled'").run(store.id);
    db.prepare('UPDATE stores SET instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', '', store.id);
    AuthMiddleware.logAudit(store.id, 0, 'INSTAGRAM_DEAUTHORIZED', 'stores', String(store.id));
  })();
  return store.id;
}

// 2. WEBHOOK ENDPOINTS (Stage 5 Security Rules)
// ==========================================
router.get('/webhook/instagram', WebhookController.verifyWebhook);
router.post('/webhook/instagram', WebhookController.handleWebhook);
router.get('/api/webhook/:storeSlug', WebhookController.verifyStoreWebhook);
router.post('/api/webhook/:storeSlug', WebhookController.handleStoreWebhook);

router.post('/api/integrations/instagram/connect', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  if (!env.instagramAppId || !env.instagramAppSecret || !env.instagramOauthRedirectUri) {
    return res.status(503).json({ success: false, error: 'Instagram OAuth yapılandırması sunucuda tamamlanmamış.' });
  }

  const state = crypto.randomBytes(32).toString('base64url');
  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  db.prepare('DELETE FROM instagram_oauth_states WHERE expires_at <= CURRENT_TIMESTAMP').run();
  db.prepare(`
    INSERT INTO instagram_oauth_states (state_hash, store_id, user_id, expires_at)
    VALUES (?, ?, ?, datetime('now', '+10 minutes'))
  `).run(stateHash, req.auth!.storeId, req.auth!.userId);

  const authorizeUrl = new URL('https://www.instagram.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.instagramAppId);
  authorizeUrl.searchParams.set('redirect_uri', env.instagramOauthRedirectUri);
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

  const stateHash = crypto.createHash('sha256').update(state).digest('hex');
  const oauthState = db.prepare(`
    SELECT state_hash, store_id, user_id FROM instagram_oauth_states
    WHERE state_hash = ? AND expires_at > CURRENT_TIMESTAMP
  `).get(stateHash) as { state_hash: string; store_id: number; user_id: number } | undefined;
  db.prepare('DELETE FROM instagram_oauth_states WHERE state_hash = ?').run(stateHash);
  if (!oauthState || !env.instagramAppId || !env.instagramAppSecret || !env.instagramOauthRedirectUri) {
    return res.status(400).send(htmlResponse('Instagram bağlantısı tamamlanamadı', 'Bağlantı isteği geçersiz veya süresi dolmuş. Lütfen yeniden deneyin.'));
  }

  try {
    const tokenForm = new URLSearchParams({
      client_id: env.instagramAppId,
      client_secret: env.instagramAppSecret,
      grant_type: 'authorization_code',
      redirect_uri: env.instagramOauthRedirectUri,
      code
    });
    const tokenResponse = await axios.post('https://api.instagram.com/oauth/access_token', tokenForm, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000
    });
    let accessToken = String(tokenResponse.data?.access_token || '');
    const instagramUserId = String(tokenResponse.data?.user_id || '');
    if (!accessToken || !instagramUserId) throw new Error('Meta geçerli bir Instagram erişim anahtarı döndürmedi.');

    try {
      const longLived = await axios.get('https://graph.instagram.com/access_token', {
        params: { grant_type: 'ig_exchange_token', client_secret: env.instagramAppSecret, access_token: accessToken }, timeout: 15_000
      });
      accessToken = String(longLived.data?.access_token || accessToken);
    } catch {
      // Short-lived token remains usable; a later refresh job can upgrade it.
    }

    const profile = await axios.get('https://graph.instagram.com/v24.0/me', {
      params: { fields: 'user_id,username', access_token: accessToken }, timeout: 15_000
    });
    const resolvedInstagramId = String(profile.data?.user_id || instagramUserId);
    const username = String(profile.data?.username || '').trim();

    // Only DM events are subscribed. This feature deliberately does not request or process comments.
    await axios.post(`https://graph.instagram.com/v24.0/${encodeURIComponent(resolvedInstagramId)}/subscribed_apps`, null, {
      params: { subscribed_fields: 'messages', access_token: accessToken }, timeout: 15_000
    });

    db.transaction(() => {
      db.prepare('UPDATE stores SET instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(resolvedInstagramId, username, oauthState.store_id);
      db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)')
        .run(oauthState.store_id, 'instagram_access_token', encryptToken(accessToken));
      db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run(oauthState.store_id, 'instagram_webhook_subscribed_at');
      db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'instagram_comment_access_enabled', '0')")
        .run(oauthState.store_id);
      db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'instagram_comment_permission_granted', '0')")
        .run(oauthState.store_id);
      db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'instagram_comment_automation_enabled', '0')")
        .run(oauthState.store_id);
      AuthMiddleware.logAudit(oauthState.store_id, oauthState.user_id, 'CONNECT_INSTAGRAM', 'stores', String(oauthState.store_id));
    })();

    return res.send(htmlResponse('Instagram bağlandı', username ? `@${username} hesabı mağazanıza bağlandı.` : 'Instagram hesabı mağazanıza bağlandı.', true));
  } catch (error: any) {
    console.error('[Instagram OAuth] Callback failed:', error.response?.data || error.message);
    return res.status(502).send(htmlResponse('Instagram bağlantısı tamamlanamadı', 'Meta erişim anahtarı alınamadı. Uygulama izinlerini ve yönlendirme adresini kontrol edin.'));
  }
});

router.post('/api/integrations/instagram/disconnect', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  const storeId = req.auth!.storeId;
  db.transaction(() => {
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").run(storeId);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_webhook_subscribed_at'").run(storeId);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_access_enabled'").run(storeId);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_permission_granted'").run(storeId);
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'instagram_comment_automation_enabled'").run(storeId);
    db.prepare('UPDATE stores SET instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('', '', storeId);
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'DISCONNECT_INSTAGRAM', 'stores', String(storeId));
  })();
  return res.json({ success: true });
});

router.get('/api/integrations/instagram/media', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  try {
    const result = await FacebookService.listInstagramMedia(req.auth!.storeId, String(req.query.after || '').trim());
    return res.json({ success: true, ...result });
  } catch (error: any) {
    const message = String(error?.message || 'Instagram gönderileri alınamadı.');
    const disconnected = message.includes('Instagram hesabını bağlayın');
    return res.status(disconnected ? 409 : 502).json({ success: false, error: message });
  }
});

router.post('/api/integrations/instagram/comments', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  return res.status(410).json({ success: false, error: 'Instagram yorum erişimi bu sürümde devre dışıdır.' });
});

// Meta calls this after the account owner removes this application's authorization.
router.post('/api/integrations/instagram/deauthorize', (req, res) => {
  const payload = parseInstagramSignedRequest(req.body?.signed_request);
  if (!payload?.user_id) return res.sendStatus(400);
  disconnectInstagramAccount(payload.user_id);
  return res.sendStatus(200);
});

// Meta calls this when the connected Instagram user requests deletion of app-held data.
router.post('/api/integrations/instagram/data-deletion', (req, res) => {
  const payload = parseInstagramSignedRequest(req.body?.signed_request);
  if (!payload?.user_id) return res.sendStatus(400);

  const storeId = disconnectInstagramAccount(payload.user_id);
  const confirmationCode = crypto.randomUUID();
  db.prepare(`
    INSERT INTO instagram_data_deletion_requests (confirmation_code, instagram_user_id, store_id, status)
    VALUES (?, ?, ?, 'completed')
  `).run(confirmationCode, payload.user_id, storeId);

  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const statusUrl = `${protocol}://${req.get('host')}/api/integrations/instagram/data-deletion/${confirmationCode}`;
  return res.status(200).json({ url: statusUrl, confirmation_code: confirmationCode });
});

router.get('/api/integrations/instagram/data-deletion/:confirmationCode', (req, res) => {
  const request = db.prepare(`
    SELECT confirmation_code, status, requested_at, completed_at
    FROM instagram_data_deletion_requests WHERE confirmation_code = ?
  `).get(String(req.params.confirmationCode || '')) as any;
  if (!request) return res.status(404).send(htmlResponse('Kayıt bulunamadı', 'Bu veri silme talebi bulunamadı.'));
  return res.send(htmlResponse('Veri silme talebi tamamlandı', `Talep kodu: ${request.confirmation_code}` , true));
});

// GET /api/integration/status (Authenticated Merchant - Scoped by req.auth.storeId)
router.get('/api/integration/status', AuthMiddleware.authenticate, (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const store = db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at FROM stores WHERE id = ?').get(storeId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    const hasInstagramToken = !!db.prepare("SELECT 1 FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").get(storeId);
    const hasInstagramCommentPermission = !!db.prepare(`
      SELECT 1 FROM settings
      WHERE store_id = ?
        AND key IN ('instagram_comment_permission_granted', 'instagram_comment_access_enabled')
        AND value = '1'
    `).get(storeId);
    const commentAutomationSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'instagram_comment_automation_enabled'").get(storeId) as any;
    const isInstagramCommentAutomationEnabled = hasInstagramCommentPermission && commentAutomationSetting?.value !== '0';
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
      instagramCommentsConnected: isConnected && hasInstagramCommentPermission,
      instagramCommentsPermissionGranted: isConnected && hasInstagramCommentPermission,
      instagramCommentAutomationEnabled: isConnected && isInstagramCommentAutomationEnabled,
      connected: isConnected,
      webhookUrl,
      globalWebhookUrl: `${req.protocol}://${req.get('host')}/webhook/instagram`,
      lastWebhookAt: store.last_webhook_at || null
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/integration/meta (Authenticated Merchant - Scoped by req.auth.storeId)
router.post('/api/integration/meta', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { metaPageId, instagramAccountId, instagramUsername } = req.body || {};

    db.prepare(`
      UPDATE stores 
      SET meta_page_id = ?, instagram_account_id = ?, instagram_username = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(metaPageId || '').trim(), String(instagramAccountId || '').trim(), String(instagramUsername || '').trim(), storeId);

    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'UPDATE_META_INTEGRATION', 'stores', String(storeId));

    return res.json({ success: true, message: 'Meta / Instagram entegrasyon bilgileri başarıyla güncellendi.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


export default router;
