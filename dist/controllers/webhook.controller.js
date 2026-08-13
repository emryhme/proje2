"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const regex_util_1 = require("../utils/regex.util");
const ai_service_1 = require("../services/ai.service");
const facebook_service_1 = require("../services/facebook.service");
const db_1 = require("../database/db");
class WebhookController {
    /**
     * Helper: Resolves store by slug strictly from database (No Fallbacks!)
     */
    static resolveStore(slug) {
        const cleanSlug = (slug || '').trim().toLowerCase();
        if (!cleanSlug)
            return null;
        try {
            const store = db_1.db.prepare('SELECT id, name, slug, status, webhook_verify_token FROM stores WHERE LOWER(slug) = ?').get(cleanSlug);
            return store || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Helper: Verifies X-Hub-Signature-256 HMAC-SHA256 Header (Security Rule 7)
     */
    static verifySignature(req) {
        const signatureHeader = (req.headers['x-hub-signature-256'] || req.headers['x-hub-signature']);
        const appSecret = process.env.INSTAGRAM_APP_SECRET || env_1.env.instagramAppSecret;
        if (!appSecret) {
            if (signatureHeader) {
                console.warn('[Webhook Signature] ⚠️ App secret is not configured in environment variables.');
            }
            return false;
        }
        if (!signatureHeader) {
            console.warn('[Webhook Signature] ❌ X-Hub-Signature-256 header missing.');
            return false;
        }
        try {
            const [algorithm, expectedHash] = signatureHeader.split('=', 2);
            const rawBody = req.rawBody;
            if (algorithm !== 'sha256' || !expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash) || !Buffer.isBuffer(rawBody)) {
                console.warn('[Webhook Signature] Invalid signature format or missing raw request body.');
                return false;
            }
            const computedHash = crypto_1.default.createHmac('sha256', appSecret).update(rawBody).digest();
            const suppliedHash = Buffer.from(expectedHash, 'hex');
            const isValid = crypto_1.default.timingSafeEqual(computedHash, suppliedHash);
            if (!isValid) {
                console.error('[Webhook Signature] ❌ HMAC Signature Mismatch!');
            }
            return isValid;
        }
        catch (e) {
            console.error('[Webhook Signature] ❌ Error computing HMAC signature:', e.message);
            return false;
        }
    }
    /**
     * Helper: Tenant-Aware Webhook Event Idempotency Check (Security Rule 6)
     */
    static isDuplicateEvent(eventId, storeId) {
        if (!eventId || !storeId)
            return false;
        try {
            const existing = db_1.db.prepare('SELECT event_id FROM webhook_events WHERE store_id = ? AND event_id = ?').get(storeId, eventId);
            if (existing) {
                console.log(`[Webhook Idempotency] ⚠️ Duplicate webhook event ignored (eventId: ${eventId}, storeId: ${storeId})`);
                return true;
            }
            db_1.db.prepare('INSERT INTO webhook_events (store_id, event_id, processed_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(storeId, eventId);
            return false;
        }
        catch (e) {
            console.warn('[Webhook Idempotency Error]:', e.message);
            return false;
        }
    }
    /**
     * Facebook / Instagram Webhook Verification (GET /webhook/instagram)
     */
    static verifyWebhook(req, res) {
        const mode = String(req.query['hub.mode'] || '');
        const token = String(req.query['hub.verify_token'] || '');
        const challenge = req.query['hub.challenge'];
        console.log(`[WebhookController] 🔍 Webhook Doğrulama İsteği Geldi: mode=${mode}, token=${token}`);
        const expectedToken = env_1.env.fbVerifyToken;
        if (mode === 'subscribe' && token === expectedToken) {
            console.log('[WebhookController] ✅ Webhook Doğrulaması Başarılı!');
            res.status(200).send(challenge);
        }
        else {
            console.warn(`[WebhookController] ❌ Webhook Verification Failed! Token: "${token}"`);
            res.sendStatus(403);
        }
    }
    /**
     * Mağazaya Özel Webhook Doğrulama (GET /api/webhook/:storeSlug)
     * Enforces Per-Store webhook_verify_token verification strictly.
     */
    static verifyStoreWebhook(req, res) {
        const storeSlug = String(req.params.storeSlug || '');
        const mode = String(req.query['hub.mode'] || '');
        const token = String(req.query['hub.verify_token'] || '');
        const challenge = req.query['hub.challenge'];
        console.log(`[WebhookController] 🔍 Store Webhook Doğrulama İsteği (${storeSlug}): mode=${mode}, token=${token}`);
        const store = WebhookController.resolveStore(storeSlug);
        if (!store) {
            console.warn(`[WebhookController] ❌ Mağaza bulunamadı: "${storeSlug}"`);
            res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
            return;
        }
        if (store.status !== 'active') {
            console.warn(`[WebhookController] ⛔ Mağaza pasif durumda: "${storeSlug}" (status: ${store.status})`);
            res.status(403).json({ success: false, error: 'Mağaza pasif durumda.' });
            return;
        }
        if (mode !== 'subscribe') {
            console.warn(`[WebhookController] ❌ Geçersiz hub.mode: "${mode}"`);
            res.status(400).json({ success: false, error: 'Geçersiz hub.mode.' });
            return;
        }
        const storeVerifyToken = store.webhook_verify_token;
        const globalVerifyToken = env_1.env.fbVerifyToken;
        // Check per-store verify token first, with global fallback if store token not configured
        const isTokenValid = (token && storeVerifyToken && token === storeVerifyToken) ||
            (token && globalVerifyToken && token === globalVerifyToken);
        if (isTokenValid) {
            console.log(`[WebhookController] ✅ ${storeSlug} Webhook Doğrulaması Başarılı!`);
            res.status(200).send(challenge);
        }
        else {
            console.warn(`[WebhookController] ❌ ${storeSlug} Verify Token Uyuşmazlığı! Gelen: "${token}"`);
            res.sendStatus(403);
        }
    }
    /**
     * Mağazaya Özel Gelen DM Mesajlarını İşleme (POST /api/webhook/:storeSlug)
     */
    static async handleStoreWebhook(req, res) {
        const storeSlug = String(req.params.storeSlug || '');
        const store = WebhookController.resolveStore(storeSlug);
        if (!store) {
            console.warn(`[WebhookController] ❌ Mağaza bulunamadı: "${storeSlug}"`);
            res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
            return;
        }
        if (store.status !== 'active') {
            console.warn(`[WebhookController] ⛔ Mağaza pasif/askıda: "${storeSlug}" (status: ${store.status})`);
            res.status(403).json({ success: false, error: 'Mağaza pasif/askıda durumdadır.' });
            return;
        }
        if (!WebhookController.verifySignature(req)) {
            res.status(401).json({ success: false, error: 'Geçersiz Webhook İmzası (Signature verification failed).' });
            return;
        }
        res.status(200).send('EVENT_RECEIVED');
        const body = req.body;
        if (!body || !body.entry || !Array.isArray(body.entry))
            return;
        for (const entry of body.entry) {
            const messagingList = entry.messaging || [];
            for (const messagingEvent of messagingList) {
                const senderId = messagingEvent.sender?.id;
                const message = messagingEvent.message;
                if (!senderId || !message || message.is_echo)
                    continue;
                const eventId = String(message.mid || `${entry.id}_${messagingEvent.timestamp || Date.now()}`);
                if (WebhookController.isDuplicateEvent(eventId, store.id)) {
                    continue;
                }
                let incomingText = message.text || '';
                if (message.attachments && message.attachments.length > 0) {
                    const attachment = message.attachments[0];
                    const title = attachment.payload?.title || '';
                    const extractedCode = (0, regex_util_1.extractProductCode)(title);
                    if (extractedCode) {
                        incomingText = `${extractedCode}\n\nMüşteri bu ürünü sipariş etmek istiyor. Lütfen stok durumunu kontrol et.`;
                    }
                }
                if (incomingText.trim()) {
                    console.log(`[Store Webhook: ${store.slug} (ID: ${store.id})] 🚀 DM Mesajı İşleniyor (${senderId}): "${incomingText}"`);
                    WebhookController.processAndReply(senderId, incomingText, store.slug, store.id);
                }
            }
            const changesList = entry.changes || [];
            for (const change of changesList) {
                const value = change.value || {};
                const senderId = value.sender?.id || value.from?.id;
                const message = value.message || value.text;
                if (!senderId)
                    continue;
                const eventId = String(value.item_id || value.comment_id || `${entry.id}_${Date.now()}`);
                if (WebhookController.isDuplicateEvent(eventId, store.id)) {
                    continue;
                }
                const incomingText = typeof message === 'string' ? message : message?.text || '';
                if (incomingText.trim()) {
                    console.log(`[Store Webhook Changes: ${store.slug} (ID: ${store.id})] 🚀 Mesaj İşleniyor (${senderId}): "${incomingText}"`);
                    WebhookController.processAndReply(senderId, incomingText, store.slug, store.id);
                }
            }
        }
    }
    /**
     * Helper: Resolves store by Meta Page ID / Instagram Account ID / Entry ID
     */
    static resolveStoreByMetaId(metaId) {
        const cleanId = (metaId || '').trim();
        if (!cleanId)
            return null;
        try {
            const store = db_1.db.prepare(`
        SELECT id, name, slug, status FROM stores 
        WHERE meta_page_id = ? OR instagram_account_id = ?
      `).get(cleanId, cleanId);
            return store || null;
        }
        catch {
            return null;
        }
    }
    /**
     * Gelen Instagram / Messenger Mesajlarını İşleme (POST /webhook/instagram)
     * Strictly resolves tenant via the verified Meta Page ID / Entry ID.
     * Client-supplied req.body.storeId or req.query.storeId is COMPLETELY IGNORED!
     */
    static async handleWebhook(req, res) {
        if (!WebhookController.verifySignature(req)) {
            res.status(401).json({ success: false, error: 'Geçersiz Webhook İmzası (Signature Verification Failed).' });
            return;
        }
        res.status(200).send('EVENT_RECEIVED');
        const body = req.body;
        if (!body || !body.entry || !Array.isArray(body.entry))
            return;
        for (const entry of body.entry) {
            const entryMetaId = String(entry.id || '');
            const matchedStore = WebhookController.resolveStoreByMetaId(entryMetaId);
            if (!matchedStore || matchedStore.status !== 'active') {
                console.warn(`[WebhookController] ⛔ Target store ${matchedStore?.slug || 'unknown'} is suspended or inactive. Skipping webhook event.`);
                continue;
            }
            // Update last_webhook_at timestamp
            try {
                db_1.db.prepare('UPDATE stores SET last_webhook_at = CURRENT_TIMESTAMP WHERE id = ?').run(matchedStore.id);
            }
            catch { }
            const messagingList = entry.messaging || [];
            for (const messagingEvent of messagingList) {
                const senderId = messagingEvent.sender?.id;
                const message = messagingEvent.message;
                if (!senderId || !message || message.is_echo)
                    continue;
                const eventId = String(message.mid || `${entry.id}_${messagingEvent.timestamp || Date.now()}`);
                if (WebhookController.isDuplicateEvent(eventId, matchedStore.id)) {
                    continue;
                }
                let incomingText = message.text || '';
                if (message.attachments && message.attachments.length > 0) {
                    const attachment = message.attachments[0];
                    const title = attachment.payload?.title || '';
                    const extractedCode = (0, regex_util_1.extractProductCode)(title);
                    if (extractedCode) {
                        incomingText = `${extractedCode}\n\nMüşteri bu ürünü sipariş etmek istiyor. Lütfen stok durumunu kontrol et.`;
                    }
                }
                if (incomingText.trim()) {
                    console.log(`[Global Webhook -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] 🚀 DM Mesajı İşleniyor (${senderId}): "${incomingText}"`);
                    WebhookController.processAndReply(senderId, incomingText, matchedStore.slug, matchedStore.id);
                }
            }
            const changesList = entry.changes || [];
            for (const change of changesList) {
                const value = change.value || {};
                const senderId = value.sender?.id || value.from?.id;
                const message = value.message || value.text;
                if (!senderId)
                    continue;
                const eventId = String(value.item_id || value.comment_id || `${entry.id}_${Date.now()}`);
                if (WebhookController.isDuplicateEvent(eventId, matchedStore.id)) {
                    continue;
                }
                const incomingText = typeof message === 'string' ? message : message?.text || '';
                if (incomingText.trim()) {
                    console.log(`[Global Webhook Changes -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] 🚀 Mesaj İşleniyor (${senderId}): "${incomingText}"`);
                    WebhookController.processAndReply(senderId, incomingText, matchedStore.slug, matchedStore.id);
                }
            }
        }
    }
    /**
     * AI Yanıtı Üretip Meta Graph API Üzerinden Müşteriye Gönderir (Store Scoped)
     */
    static async processAndReply(senderId, text, storeSlug, storeId) {
        try {
            const conversationId = ai_service_1.AIService.getOrCreateConversation(storeId, `instagram:${senderId}`);
            ai_service_1.AIService.persistMessage(conversationId, 'user', text);
            const { reply, toolTraces } = await ai_service_1.AIService.processMessage(senderId, text, storeSlug, storeId);
            ai_service_1.AIService.persistMessage(conversationId, 'assistant', reply);
            for (const trace of toolTraces) {
                console.log(`[AI Tool] Store=${storeId} Sender=${senderId} Tool=${trace.toolName} Status=${trace.status} Args=${JSON.stringify(trace.args)} Result=${String(trace.result).slice(0, 500)}`);
            }
            await facebook_service_1.FacebookService.sendMessage(senderId, reply, storeId);
        }
        catch (error) {
            console.error(`[WebhookController] ❌ Mesaj işleme hatası (Store: ${storeSlug}/${storeId}, Sender: ${senderId}):`, error?.message || error);
        }
    }
}
exports.WebhookController = WebhookController;
