import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';
import { db } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

// 2. WEBHOOK ENDPOINTS (Stage 5 Security Rules)
// ==========================================
router.get('/webhook/instagram', WebhookController.verifyWebhook);
router.post('/webhook/instagram', WebhookController.handleWebhook);
router.get('/api/webhook/:storeSlug', WebhookController.verifyStoreWebhook);
router.post('/api/webhook/:storeSlug', WebhookController.handleStoreWebhook);

// GET /api/integration/status (Authenticated Merchant - Scoped by req.auth.storeId)
router.get('/api/integration/status', AuthMiddleware.authenticate, (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const store = db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at FROM stores WHERE id = ?').get(storeId) as any;
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

    return res.json({ success: true, message: 'Meta / Instagram entegrasyon bilgileri baÃ…Å¸arÃ„Â±yla gÃƒÂ¼ncellendi.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


export default router;
