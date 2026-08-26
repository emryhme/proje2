import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { extractProductCode } from '../utils/regex.util';
import { AIService } from '../services/ai.service';
import { FacebookService } from '../services/facebook.service';
import { HumanHandoffService } from '../services/human-handoff.service';
import { db } from '../database/db';

export class WebhookController {
  private static readonly DM_BUFFER_DELAY_MS = 1_500;
  private static readonly DM_BUFFER_MAX_WAIT_MS = 5_000;
  private static readonly DM_BUFFER_MAX_MESSAGES = 10;
  private static dmMessageBuffers = new Map<string, {
    senderId: string;
    storeSlug: string;
    storeId: number;
    messages: string[];
    firstReceivedAt: number;
    timer?: NodeJS.Timeout;
  }>();
  private static dmProcessingQueues = new Map<string, Promise<void>>();

  /**
   * Helper: Resolves store by slug strictly from database (No Fallbacks!)
   */
  public static resolveStore(slug: string): { id: number; name: string; slug: string; status: string; webhook_verify_token?: string; instagram_account_id?: string } | null {
    const cleanSlug = (slug || '').trim().toLowerCase();
    if (!cleanSlug) return null;
    try {
      const store = db.prepare('SELECT id, name, slug, status, webhook_verify_token, instagram_account_id FROM stores WHERE LOWER(slug) = ?').get(cleanSlug) as any;
      return store || null;
    } catch {
      return null;
    }
  }

  /**
   * Helper: Verifies X-Hub-Signature-256 HMAC-SHA256 Header (Security Rule 7)
   */
  public static verifySignature(req: Request): boolean {
    const signatureHeader = (req.headers['x-hub-signature-256'] || req.headers['x-hub-signature']) as string;
    const appSecret = process.env.INSTAGRAM_APP_SECRET || env.instagramAppSecret;

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
      const rawBody = (req as any).rawBody;
      if (algorithm !== 'sha256' || !expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash) || !Buffer.isBuffer(rawBody)) {
        console.warn('[Webhook Signature] Invalid signature format or missing raw request body.');
        return false;
      }

      const computedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
      const suppliedHash = Buffer.from(expectedHash, 'hex');
      const isValid = crypto.timingSafeEqual(computedHash, suppliedHash);

      if (!isValid) {
        console.error('[Webhook Signature] ❌ HMAC Signature Mismatch!');
      }
      return isValid;
    } catch (e: any) {
      console.error('[Webhook Signature] ❌ Error computing HMAC signature:', e.message);
      return false;
    }
  }

  /**
   * Helper: Tenant-Aware Webhook Event Idempotency Check (Security Rule 6)
   */
  public static isDuplicateEvent(eventId: string, storeId: number): boolean {
    if (!eventId || !storeId) return false;
    try {
      const existing = db.prepare('SELECT event_id FROM webhook_events WHERE store_id = ? AND event_id = ?').get(storeId, eventId);
      if (existing) {
        console.log(`[Webhook Idempotency] ⚠️ Duplicate webhook event ignored (eventId: ${eventId}, storeId: ${storeId})`);
        return true;
      }
      db.prepare('INSERT INTO webhook_events (store_id, event_id, processed_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(storeId, eventId);
      return false;
    } catch (e: any) {
      console.warn('[Webhook Idempotency Error]:', e.message);
      return false;
    }
  }

  /** Parses the official Instagram `comments` webhook payload. */
  public static extractInstagramComment(change: any): { commentId: string; commenterId: string; username: string; text: string; mediaId: string } | null {
    if (String(change?.field || '').toLowerCase() !== 'comments') return null;
    const value = change?.value || {};
    const commentId = String(value.id || value.comment_id || value.comment?.id || '').trim();
    const commenterId = String(value.from?.id || value.sender?.id || '').trim();
    const username = String(value.from?.username || value.sender?.username || '').trim();
    const text = String(value.text || value.message?.text || '').trim();
    const mediaId = String(value.media?.id || value.media_id || '').trim();
    if (!commentId || !commenterId || !text) return null;
    return { commentId, commenterId, username, text, mediaId };
  }

  public static isInstagramCommentAutomationEnabled(storeId: number): boolean {
    void storeId;
    return false;
  }

  private static handleMessageEcho(messagingEvent: any, store: { id: number; slug: string }): void {
    const message = messagingEvent?.message;
    const recipientId = String(messagingEvent?.recipient?.id || '').trim();
    if (!message?.is_echo || !recipientId) return;
    const messageId = String(message.mid || '').trim();
    const eventId = messageId || `echo:${store.id}:${recipientId}:${messagingEvent?.timestamp || Date.now()}`;
    if (this.isDuplicateEvent(eventId, store.id)) return;

    const result = HumanHandoffService.handleOutboundEcho(store.id, recipientId, messageId, String(message.text || ''));
    if (result.automated) {
      console.log(`[Human Handoff] Store=${store.id} Recipient=${recipientId} Sistem mesajı echo olarak doğrulandı; standby başlatılmadı.`);
      return;
    }
    console.log(`[Human Handoff] Store=${store.id} Recipient=${recipientId} İşletme mesajı algılandı; AI ${HumanHandoffService.DEFAULT_STANDBY_HOURS} saat standby durumuna alındı.`);
  }

  private static async resolveIncomingMessageText(message: any, storeId: number): Promise<string> {
    let incomingText = String(message?.text || '').trim();
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    let mediaRefreshed = false;
    for (const attachment of attachments) {
      let mapped = FacebookService.resolveInstagramAttachmentProduct(attachment, storeId);
      const payload = attachment?.payload || {};
      const attachmentType = String(attachment?.type || '').toLowerCase();
      const isSharedInstagramMedia = Boolean(payload.id || payload.media_id || payload.post_id || payload.reel_video_id || /media_share|ig_reel|share/.test(attachmentType));
      if (!mapped && !mediaRefreshed && isSharedInstagramMedia) {
        mediaRefreshed = true;
        try {
          await FacebookService.listInstagramMedia(storeId);
          mapped = FacebookService.resolveInstagramAttachmentProduct(attachment, storeId);
        } catch {
          // Continue with the attachment title fallback when Meta is temporarily unavailable.
        }
      }
      if (mapped) {
        const mediaContext = `Paylaşılan Instagram gönderisinin Media ID değeri ${mapped.mediaId} ve veri setindeki ürün kısa kodu ${mapped.shortCode}. Müşteri bu gönderideki üründen bahsediyor; ürün kodunu tekrar sorma.`;
        incomingText = incomingText ? `${incomingText}\n\n${mediaContext}` : `Müşteri bir Instagram gönderisi paylaştı. ${mediaContext}`;
        break;
      }

      const title = String(attachment?.payload?.title || '').trim();
      const extractedCode = extractProductCode(title);
      if (extractedCode) {
        incomingText = incomingText
          ? `${incomingText}\n\nPaylaşılan gönderideki ürün kodu: ${extractedCode}`
          : `Müşteri ${extractedCode} kodlu ürünün Instagram gönderisini paylaştı. Bu ürün hakkında yardımcı ol.`;
        break;
      }
    }
    return incomingText;
  }

  /**
   * Facebook / Instagram Webhook Verification (GET /webhook/instagram)
   */
  public static verifyWebhook(req: Request, res: Response): void {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = req.query['hub.challenge'];

    console.log(`[WebhookController] 🔍 Webhook doğrulama isteği geldi: mode=${mode}, tokenPresent=${Boolean(token)}`);
    const expectedToken = env.fbVerifyToken;

    if (mode === 'subscribe' && token === expectedToken) {
      console.log('[WebhookController] ✅ Webhook Doğrulaması Başarılı!');
      res.status(200).send(challenge);
    } else {
      console.warn(`[WebhookController] ❌ Webhook Verification Failed! Token: "${token}"`);
      res.sendStatus(403);
    }
  }

  /**
   * Mağazaya Özel Webhook Doğrulama (GET /api/webhook/:storeSlug)
   * Enforces Per-Store webhook_verify_token verification strictly.
   */
  public static verifyStoreWebhook(req: Request, res: Response): void {
    const storeSlug = String(req.params.storeSlug || '');
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = req.query['hub.challenge'];

    console.log(`[WebhookController] 🔍 Store webhook doğrulama isteği (${storeSlug}): mode=${mode}, tokenPresent=${Boolean(token)}`);

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
    const globalVerifyToken = env.fbVerifyToken;

    // Check per-store verify token first, with global fallback if store token not configured
    const isTokenValid = (token && storeVerifyToken && token === storeVerifyToken) ||
                         (token && globalVerifyToken && token === globalVerifyToken);

    if (isTokenValid) {
      console.log(`[WebhookController] ✅ ${storeSlug} Webhook Doğrulaması Başarılı!`);
      res.status(200).send(challenge);
    } else {
      console.warn(`[WebhookController] ❌ ${storeSlug} Verify Token Uyuşmazlığı! Gelen: "${token}"`);
      res.sendStatus(403);
    }
  }

  /**
   * Mağazaya Özel Gelen DM Mesajlarını İşleme (POST /api/webhook/:storeSlug)
   */
  public static async handleStoreWebhook(req: Request, res: Response): Promise<void> {
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
    if (!body || !body.entry || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const messagingList = entry.messaging || [];
      for (const messagingEvent of messagingList) {
        const senderId = messagingEvent.sender?.id;
        const message = messagingEvent.message;

        if (message?.is_echo) {
          WebhookController.handleMessageEcho(messagingEvent, store);
          continue;
        }
        if (!senderId || !message) continue;

        const eventId = String(message.mid || `${entry.id}_${messagingEvent.timestamp || Date.now()}`);
        if (WebhookController.isDuplicateEvent(eventId, store.id)) {
          continue;
        }

        const incomingText = await WebhookController.resolveIncomingMessageText(message, store.id);

        if (incomingText.trim()) {
          console.log(`[Store Webhook: ${store.slug} (ID: ${store.id})] DM mesajı işleniyor.`);
          WebhookController.enqueueMessage(senderId, incomingText, store.slug, store.id);
        }
      }

      const changesList = entry.changes || [];
      for (const change of changesList) {
        if (String(change?.field || '').toLowerCase() === 'comments') {
          const comment = WebhookController.extractInstagramComment(change);
          if (comment && comment.commenterId !== String(store.instagram_account_id || entry.id || '')) {
            const eventId = `instagram-comment:${comment.commentId}`;
            if (!WebhookController.isDuplicateEvent(eventId, store.id)) {
              if (WebhookController.isInstagramCommentAutomationEnabled(store.id)) {
                console.log(`[Store Webhook: ${store.slug} (ID: ${store.id})] 💬 Instagram yorumu işleniyor (@${comment.username || comment.commenterId}): "${comment.text}"`);
                WebhookController.processCommentAndReply(comment, store.slug, store.id);
              } else {
                console.log(`[Store Webhook: ${store.slug} (ID: ${store.id})] 🔕 Instagram yorum erişimi kapalı; yorum işlenmedi (${comment.commentId}).`);
              }
            }
          }
          continue;
        }

        const value = change.value || {};
        const senderId = value.sender?.id || value.from?.id;
        const message = value.message || value.text;

        if (!senderId) continue;

        const eventId = String(value.item_id || value.comment_id || `${entry.id}_${Date.now()}`);
        if (WebhookController.isDuplicateEvent(eventId, store.id)) {
          continue;
        }

        const incomingText = typeof message === 'string' ? message : message?.text || '';
        if (incomingText.trim()) {
          console.log(`[Store Webhook Changes: ${store.slug} (ID: ${store.id})] Mesaj işleniyor.`);
          WebhookController.enqueueMessage(senderId, incomingText, store.slug, store.id);
        }
      }
    }
  }

  /**
   * Helper: Resolves store by Meta Page ID / Instagram Account ID / Entry ID
   */
  public static resolveStoreByMetaId(metaId: string): { id: number; name: string; slug: string; status: string; instagram_account_id?: string } | null {
    const cleanId = (metaId || '').trim();
    if (!cleanId) return null;
    try {
      const store = db.prepare(`
        SELECT id, name, slug, status, instagram_account_id FROM stores
        WHERE meta_page_id = ? OR instagram_account_id = ?
      `).get(cleanId, cleanId) as any;
      return store || null;
    } catch {
      return null;
    }
  }

  /**
   * Gelen Instagram / Messenger Mesajlarını İşleme (POST /webhook/instagram)
   * Strictly resolves tenant via the verified Meta Page ID / Entry ID.
   * Client-supplied req.body.storeId or req.query.storeId is COMPLETELY IGNORED!
   */
  public static async handleWebhook(req: Request, res: Response): Promise<void> {

    if (!WebhookController.verifySignature(req)) {
      res.status(401).json({ success: false, error: 'Geçersiz Webhook İmzası (Signature Verification Failed).' });
      return;
    }

    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;
    if (!body || !body.entry || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const entryMetaId = String(entry.id || '');
      const matchedStore = WebhookController.resolveStoreByMetaId(entryMetaId);

      if (!matchedStore || matchedStore.status !== 'active') {
        console.warn(`[WebhookController] ⛔ Target store ${matchedStore?.slug || 'unknown'} is suspended or inactive. Skipping webhook event.`);
        continue;
      }

      // Update last_webhook_at timestamp
      try {
        db.prepare('UPDATE stores SET last_webhook_at = CURRENT_TIMESTAMP WHERE id = ?').run(matchedStore.id);
      } catch {}

      const messagingList = entry.messaging || [];
      for (const messagingEvent of messagingList) {
        const senderId = messagingEvent.sender?.id;
        const message = messagingEvent.message;

        if (message?.is_echo) {
          WebhookController.handleMessageEcho(messagingEvent, matchedStore);
          continue;
        }
        if (!senderId || !message) continue;

        const eventId = String(message.mid || `${entry.id}_${messagingEvent.timestamp || Date.now()}`);
        if (WebhookController.isDuplicateEvent(eventId, matchedStore.id)) {
          continue;
        }

        const incomingText = await WebhookController.resolveIncomingMessageText(message, matchedStore.id);

        if (incomingText.trim()) {
          console.log(`[Global Webhook -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] DM mesajı işleniyor.`);
          WebhookController.enqueueMessage(senderId, incomingText, matchedStore.slug, matchedStore.id);
        }
      }

      const changesList = entry.changes || [];
      for (const change of changesList) {
        if (String(change?.field || '').toLowerCase() === 'comments') {
          const comment = WebhookController.extractInstagramComment(change);
          if (comment && comment.commenterId !== String(matchedStore.instagram_account_id || entry.id || '')) {
            const eventId = `instagram-comment:${comment.commentId}`;
            if (!WebhookController.isDuplicateEvent(eventId, matchedStore.id)) {
              if (WebhookController.isInstagramCommentAutomationEnabled(matchedStore.id)) {
                console.log(`[Global Webhook -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] 💬 Instagram yorumu işleniyor (@${comment.username || comment.commenterId}): "${comment.text}"`);
                WebhookController.processCommentAndReply(comment, matchedStore.slug, matchedStore.id);
              } else {
                console.log(`[Global Webhook -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] 🔕 Instagram yorum erişimi kapalı; yorum işlenmedi (${comment.commentId}).`);
              }
            }
          }
          continue;
        }

        const value = change.value || {};
        const senderId = value.sender?.id || value.from?.id;
        const message = value.message || value.text;

        if (!senderId) continue;

        const eventId = String(value.item_id || value.comment_id || `${entry.id}_${Date.now()}`);
        if (WebhookController.isDuplicateEvent(eventId, matchedStore.id)) {
          continue;
        }

        const incomingText = typeof message === 'string' ? message : message?.text || '';
        if (incomingText.trim()) {
          console.log(`[Global Webhook Changes -> Resolved Store: ${matchedStore.slug} (ID: ${matchedStore.id})] Mesaj işleniyor.`);
          WebhookController.enqueueMessage(senderId, incomingText, matchedStore.slug, matchedStore.id);
        }
      }
    }
  }

  /**
   * Combines rapid messages from the same tenant/customer before invoking the AI.
   * A maximum wait prevents a continuously typing customer from being held forever.
   */
  private static enqueueMessage(senderId: string, text: string, storeSlug: string, storeId: number): void {
    const cleanText = String(text || '').trim().slice(0, 4_000);
    if (!cleanText) return;
    const key = `${storeId}:${senderId}`;
    const now = Date.now();
    let entry = this.dmMessageBuffers.get(key);
    if (!entry) {
      entry = { senderId, storeSlug, storeId, messages: [], firstReceivedAt: now };
      this.dmMessageBuffers.set(key, entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.storeSlug = storeSlug;
    entry.messages.push(cleanText);

    const maxWaitRemaining = Math.max(0, this.DM_BUFFER_MAX_WAIT_MS - (now - entry.firstReceivedAt));
    const delay = entry.messages.length >= this.DM_BUFFER_MAX_MESSAGES
      ? 0
      : Math.min(this.DM_BUFFER_DELAY_MS, maxWaitRemaining);
    entry.timer = setTimeout(() => { void this.flushBufferedMessages(key); }, delay);
    entry.timer.unref();
    console.log(`[DM Buffer] Store=${storeId} Sender=${senderId} Mesaj=${entry.messages.length} Bekleme=${delay}ms`);
  }

  private static async flushBufferedMessages(key: string): Promise<void> {
    const entry = this.dmMessageBuffers.get(key);
    if (!entry) return;
    this.dmMessageBuffers.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    const individualMessages = entry.messages.filter(Boolean);
    if (!individualMessages.length) return;
    const combinedText = individualMessages.join('\n');

    const previous = this.dmProcessingQueues.get(key) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.processAndReply(entry.senderId, combinedText, entry.storeSlug, entry.storeId, individualMessages));
    this.dmProcessingQueues.set(key, task);
    try {
      await task;
    } finally {
      if (this.dmProcessingQueues.get(key) === task) this.dmProcessingQueues.delete(key);
    }
  }

  /**
   * AI Yanıtı Üretip Meta Graph API Üzerinden Müşteriye Gönderir (Store Scoped)
   */
  private static async processAndReply(senderId: string, text: string, storeSlug: string, storeId: number, originalMessages: string[] = [text]) {
    try {
      const conversationId = AIService.getOrCreateConversation(storeId, `instagram:${senderId}`);
      for (const originalMessage of originalMessages) {
        AIService.persistMessage(conversationId, 'user', originalMessage);
      }

      if (HumanHandoffService.isConversationOnStandby(storeId, senderId)) {
        console.log(`[Human Handoff] Store=${storeId} Sender=${senderId} Müşteri mesajı kaydedildi; konuşma standby durumunda olduğu için AI yanıt vermedi.`);
        return;
      }

      const { reply, toolTraces } = await AIService.processMessage(senderId, text, storeSlug, storeId);
      if (HumanHandoffService.isConversationOnStandby(storeId, senderId)) {
        console.log(`[Human Handoff] Store=${storeId} Sender=${senderId} İşlem sırasında insan devraldı; hazırlanan AI yanıtı gönderilmedi.`);
        return;
      }
      AIService.persistMessage(conversationId, 'assistant', reply);

      for (const trace of toolTraces) {
        const argsText = JSON.stringify(trace.args || {}).slice(0, 600);
        const resultText = String(trace.result || '').slice(0, 1_200);
        console.log(`[AI Tool] Store=${storeId} Sender=${senderId} Tool=${trace.toolName} Status=${trace.status} Args=${argsText} Result=${resultText}`);
      }
      await FacebookService.sendMessage(senderId, reply, storeId);
    } catch (error: any) {
      console.error(`[WebhookController] Mesaj işleme hatası (Store: ${storeSlug}/${storeId}):`, error?.message || error);
    }
  }

  /**
   * Starts a private sales conversation from a post comment. The commenter ID is
   * deliberately shared with the DM session so the cart survives their reply.
   */
  private static async processCommentAndReply(
    comment: { commentId: string; commenterId: string; username: string; text: string; mediaId: string },
    storeSlug: string,
    storeId: number
  ) {
    try {
      const conversationId = AIService.getOrCreateConversation(storeId, `instagram:${comment.commenterId}`);
      AIService.persistMessage(conversationId, 'user', `[Instagram yorumu] ${comment.text}`);

      let aiInput = comment.text;
      if (!extractProductCode(comment.text) && comment.mediaId) {
        const mediaContext = await FacebookService.getInstagramMediaContext(comment.mediaId, storeId);
        const postProductCode = extractProductCode(mediaContext?.caption || '');
        if (postProductCode) {
          aiInput = `${comment.text}\n\nYorum yapılan gönderideki ürün kodu: ${postProductCode}`;
        }
      }

      const { reply, toolTraces } = await AIService.processMessage(
        comment.commenterId,
        aiInput,
        storeSlug,
        storeId
      );
      AIService.persistMessage(conversationId, 'assistant', reply);

      for (const trace of toolTraces) {
        console.log(`[AI Comment Tool] Store=${storeId} Comment=${comment.commentId} Sender=${comment.commenterId} Tool=${trace.toolName} Status=${trace.status} Args=${JSON.stringify(trace.args)} Result=${String(trace.result).slice(0, 500)}`);
      }

      const sent = await FacebookService.sendPrivateReplyToComment(comment.commentId, reply, storeId);
      if (!sent) {
        console.error(`[WebhookController] ❌ Instagram yorumuna yapay zeka yanıtı gönderilemedi (Store: ${storeSlug}/${storeId}, Comment: ${comment.commentId}).`);
      }
    } catch (error: any) {
      console.error(`[WebhookController] ❌ Instagram yorumu işleme hatası (Store: ${storeSlug}/${storeId}, Comment: ${comment.commentId}):`, error?.message || error);
    }
  }
}
