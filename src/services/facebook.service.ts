import axios from 'axios';
import crypto from 'crypto';
import { db } from '../database/db';
import { env } from '../config/env';
import { decryptSettingSecret } from '../utils/secret.util';

/**
 * Facebook Graph API (Instagram DM / Messenger) Yanıt Gönderme Servisi (Store Scoped)
 */
export class FacebookService {
  private static decryptToken(value: string): string {
    const [version, ivText, encryptedText, authTagText] = value.split(':');
    if (version !== 'v1' || !ivText || !encryptedText || !authTagText) {
      throw new Error('Geçersiz Instagram erişim anahtarı biçimi.');
    }
    const key = crypto.createHash('sha256').update(`${env.jwtSecret}:instagram-token-v1`).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  }

  private static getInstagramCredentials(storeId: number): { accountId: string; accessToken: string; host: string } | null {
    const instagram = db.prepare(`
      SELECT s.instagram_account_id, k.value AS encrypted_token
      FROM stores s LEFT JOIN settings k ON k.store_id = s.id AND k.key = 'instagram_access_token'
      WHERE s.id = ?
    `).get(storeId) as any;
    const pageSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId) as any;
    const accountId = String(instagram?.instagram_account_id || '').trim();
    const isInstagramLogin = Boolean(accountId && instagram?.encrypted_token);
    const accessToken = isInstagramLogin
      ? this.decryptToken(String(instagram.encrypted_token))
      : decryptSettingSecret(String(pageSetting?.value || '')).trim();
    if (!accountId || !accessToken) return null;
    return { accountId, accessToken, host: isInstagramLogin ? 'graph.instagram.com' : 'graph.facebook.com' };
  }

  private static normalizeMediaUrl(value: unknown): string {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
      const url = new URL(input);
      return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
    } catch {
      return input.split(/[?#]/, 1)[0].replace(/\/$/, '');
    }
  }

  private static normalizeProductCode(value: unknown): string {
    return String(value || '').trim().toLocaleUpperCase('tr-TR');
  }

  private static extractCaptionProductCode(caption: unknown): string {
    const text = String(caption || '');
    const match = text.match(/(?:ürün|urun)\s*kodu\s*[:：=\-]\s*([a-z0-9çğıöşü][a-z0-9çğıöşü._\/-]{0,79})/iu);
    return this.normalizeProductCode(String(match?.[1] || '').replace(/[.,;!?)}\]]+$/u, ''));
  }

  /** Maps the newest post containing "Ürün Kodu: ..." to the matching product family. */
  private static autoAssignCaptionProducts(storeId: number, media: any[]): void {
    const products = db.prepare(`
      SELECT product_code AS productCode, short_code AS shortCode, instagram_media_id AS mediaId
      FROM products WHERE store_id = ? ORDER BY id ASC
    `).all(storeId) as any[];
    if (!products.length) return;

    const claimedFamilies = new Set<string>();
    const findFamily = (code: string): string => {
      const exactVariant = products.find(product => this.normalizeProductCode(product.productCode) === code);
      const exactFamily = products.find(product => this.normalizeProductCode(product.shortCode) === code);
      return this.normalizeProductCode(exactVariant?.shortCode || exactFamily?.shortCode || '');
    };

    const assign = db.transaction((mediaId: string, shortCode: string) => {
      db.prepare("UPDATE products SET instagram_media_id = '', updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND instagram_media_id = ?")
        .run(storeId, mediaId);
      db.prepare("UPDATE products SET instagram_media_id = '', updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND UPPER(short_code) = UPPER(?)")
        .run(storeId, shortCode);
      db.prepare('UPDATE products SET instagram_media_id = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND UPPER(short_code) = UPPER(?)')
        .run(mediaId, storeId, shortCode);
    });

    for (const item of media) {
      const captionCode = this.extractCaptionProductCode(item?.caption);
      const shortCode = captionCode ? findFamily(captionCode) : '';
      if (!shortCode || claimedFamilies.has(shortCode)) continue;
      claimedFamilies.add(shortCode);
      const familyRows = products.filter(product => this.normalizeProductCode(product.shortCode) === shortCode);
      const alreadyAssigned = familyRows.length > 0 && familyRows.every(product => String(product.mediaId || '') === String(item.id));
      if (!alreadyAssigned) assign(String(item.id), shortCode);
    }
  }

  /** Synchronizes the connected professional account's own posts without reading comments. */
  public static async listInstagramMedia(storeId: number, after = ''): Promise<{ media: any[]; nextCursor: string; source: 'instagram' | 'cache'; warning?: string }> {
    if (!Number.isInteger(storeId) || storeId <= 0) throw new Error('Store ID zorunludur.');
    const credentials = this.getInstagramCredentials(storeId);
    if (!credentials) throw new Error('Önce Instagram hesabını bağlayın.');

    try {
      const response = await axios.get(`https://${credentials.host}/v24.0/${encodeURIComponent(credentials.accountId)}/media`, {
        params: {
          fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
          limit: 50,
          ...(after ? { after } : {}),
          access_token: credentials.accessToken
        },
        timeout: 15_000
      });
      const media = (Array.isArray(response.data?.data) ? response.data.data : []).map((item: any) => ({
        id: String(item?.id || '').trim(),
        caption: String(item?.caption || '').trim(),
        mediaType: String(item?.media_type || '').trim(),
        mediaProductType: String(item?.media_product_type || '').trim(),
        mediaUrl: String(item?.media_url || '').trim(),
        thumbnailUrl: String(item?.thumbnail_url || '').trim(),
        permalink: String(item?.permalink || '').trim(),
        timestamp: String(item?.timestamp || '').trim()
      })).filter((item: any) => item.id);

      const upsert = db.prepare(`
        INSERT INTO instagram_media_catalog (
          store_id, media_id, caption, media_type, media_product_type, media_url,
          thumbnail_url, permalink, published_at, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, media_id) DO UPDATE SET
          caption=excluded.caption, media_type=excluded.media_type,
          media_product_type=excluded.media_product_type, media_url=excluded.media_url,
          thumbnail_url=excluded.thumbnail_url, permalink=excluded.permalink,
          published_at=excluded.published_at, synced_at=CURRENT_TIMESTAMP
      `);
      db.transaction(() => media.forEach((item: any) => upsert.run(
        storeId, item.id, item.caption, item.mediaType, item.mediaProductType,
        item.mediaUrl, item.thumbnailUrl, item.permalink, item.timestamp || null
      )))();

      return {
        media: this.attachProductMappings(storeId, media),
        nextCursor: String(response.data?.paging?.cursors?.after || ''),
        source: 'instagram'
      };
    } catch (error: any) {
      const cached = this.getCachedInstagramMedia(storeId);
      if (cached.length) {
        return { media: cached, nextCursor: '', source: 'cache', warning: 'Instagram yenilenemedi; son senkronize edilen gönderiler gösteriliyor.' };
      }
      const details = error?.response?.data?.error?.message || error?.message || 'Instagram gönderileri alınamadı.';
      throw new Error(details);
    }
  }

  private static attachProductMappings(storeId: number, media: any[]): any[] {
    this.autoAssignCaptionProducts(storeId, media);
    const mappings = db.prepare(`
      SELECT instagram_media_id AS mediaId, product_code AS productCode, short_code AS shortCode, name
      FROM products WHERE store_id = ? AND instagram_media_id != ''
    `).all(storeId) as any[];
    const byMedia = new Map<string, any[]>();
    for (const mapping of mappings) {
      const key = String(mapping.mediaId || '');
      if (!byMedia.has(key)) byMedia.set(key, []);
      byMedia.get(key)!.push(mapping);
    }
    return media.map(item => ({ ...item, products: byMedia.get(String(item.id)) || [] }));
  }

  public static getCachedInstagramMedia(storeId: number): any[] {
    const rows = db.prepare(`
      SELECT media_id AS id, caption, media_type AS mediaType, media_product_type AS mediaProductType,
             media_url AS mediaUrl, thumbnail_url AS thumbnailUrl, permalink, published_at AS timestamp
      FROM instagram_media_catalog WHERE store_id = ? ORDER BY published_at DESC, synced_at DESC LIMIT 100
    `).all(storeId) as any[];
    return this.attachProductMappings(storeId, rows);
  }

  /** Re-runs caption-to-product matching from the local catalog without a Meta request. */
  public static reconcileCachedInstagramMedia(storeId: number): number {
    if (!Number.isInteger(storeId) || storeId <= 0) return 0;
    return this.getCachedInstagramMedia(storeId).length;
  }

  /** Background refresh for every active tenant with a connected Instagram account. */
  public static async syncConnectedInstagramStores(): Promise<{ stores: number; refreshed: number; failed: number }> {
    const stores = db.prepare(`
      SELECT DISTINCT s.id
      FROM stores s
      JOIN settings token ON token.store_id = s.id AND token.key IN ('instagram_access_token', 'facebook_page_access_token') AND token.value != ''
      WHERE s.status = 'active' AND s.instagram_account_id != ''
      ORDER BY s.id ASC
    `).all() as Array<{ id: number }>;
    let refreshed = 0;
    let failed = 0;
    for (const store of stores) {
      try {
        const result = await this.listInstagramMedia(Number(store.id));
        if (result.source === 'instagram') refreshed += 1;
        else failed += 1;
      } catch (error: any) {
        failed += 1;
        console.warn(`[Instagram Background Sync] Store=${store.id} yenilenemedi: ${String(error?.message || error)}`);
      }
    }
    return { stores: stores.length, refreshed, failed };
  }

  /** Resolves a shared post/reel attachment to one unambiguous tenant product family. */
  public static resolveInstagramAttachmentProduct(attachment: any, storeId: number): { mediaId: string; productCode: string; shortCode: string } | null {
    if (!Number.isInteger(storeId) || storeId <= 0) return null;
    const payload = attachment?.payload || {};
    const directMediaId = [payload.id, payload.media_id, payload.post_id, payload.reel_video_id, attachment?.media_id]
      .map(value => String(value || '').trim())
      .find(Boolean) || '';
    let mediaId = directMediaId;

    if (!mediaId) {
      const attachmentUrls = [payload.url, payload.link, attachment?.url].map(value => this.normalizeMediaUrl(value)).filter(Boolean);
      if (attachmentUrls.length) {
        const catalog = db.prepare(`
          SELECT media_id, media_url, thumbnail_url, permalink
          FROM instagram_media_catalog WHERE store_id = ?
        `).all(storeId) as any[];
        const match = catalog.find(item => {
          const knownUrls = [item.media_url, item.thumbnail_url, item.permalink].map(value => this.normalizeMediaUrl(value)).filter(Boolean);
          return attachmentUrls.some(url => knownUrls.includes(url));
        });
        mediaId = String(match?.media_id || '').trim();
      }
    }
    if (!mediaId) return null;

    const products = db.prepare(`
      SELECT product_code, short_code FROM products
      WHERE store_id = ? AND instagram_media_id = ?
      ORDER BY id ASC
    `).all(storeId, mediaId) as any[];
    const shortCodes = [...new Set(products.map(item => String(item.short_code || '').trim().toUpperCase()).filter(Boolean))];
    if (!products.length || shortCodes.length !== 1) return null;
    return {
      mediaId,
      productCode: String(products[0].product_code || shortCodes[0]).trim().toUpperCase(),
      shortCode: shortCodes[0]
    };
  }

  /**
   * Müşteriye yanıt mesajı gönderir (Per-Store Credential Support).
   */
  public static async sendMessage(recipientId: string, text: string, storeId: number): Promise<boolean> {
    if (!Number.isInteger(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur.');
    }
    const instagram = db.prepare(`
      SELECT s.instagram_account_id, k.value AS encrypted_token
      FROM stores s LEFT JOIN settings k ON k.store_id = s.id AND k.key = 'instagram_access_token'
      WHERE s.id = ?
    `).get(storeId) as any;
    const setting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId) as any;
    const isInstagramLogin = Boolean(instagram?.instagram_account_id && instagram?.encrypted_token);
    let accessToken = decryptSettingSecret(String(setting?.value || '')).trim();
    if (isInstagramLogin) {
      accessToken = this.decryptToken(String(instagram.encrypted_token));
    }

    if (!accessToken) {
      console.warn(`[FacebookService] ⚠️ FB Page Access Token eksik (Store: ${storeId || 'default'}), mesaj konsola yazdırılıyor:`);
      console.log('[FacebookService] Geliştirme modunda mesaj gönderimi simüle edildi.');
      return false;
    }

    const sanitizedText = text ? text.trim() : '';

    try {
      const url = isInstagramLogin
        ? `https://graph.instagram.com/v24.0/${encodeURIComponent(instagram.instagram_account_id)}/messages`
        : 'https://graph.facebook.com/v21.0/me/messages';
      const res = await axios.post(
        url,
        {
          recipient: isInstagramLogin ? { id: recipientId } : { id: recipientId },
          message: { text: sanitizedText }
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`[FacebookService] 📤 Mesaj başarıyla gönderildi -> ${recipientId} (Store: ${storeId || 'default'}, Status: ${res.status})`);
      return true;
    } catch (error: any) {
      const errDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
      console.error(`[FacebookService] ❌ Mesaj gönderim hatası (${recipientId}):`, errDetails);
      return false;
    }
  }

  /**
   * Sends the single private reply Meta permits for an Instagram post comment.
   * Further replies continue through the normal DM webhook after the customer responds.
   */
  public static async sendPrivateReplyToComment(commentId: string, text: string, storeId: number): Promise<boolean> {
    if (!Number.isInteger(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur.');
    }
    const cleanCommentId = String(commentId || '').trim();
    const sanitizedText = String(text || '').trim().slice(0, 1000);
    if (!cleanCommentId || !sanitizedText) return false;

    const instagram = db.prepare(`
      SELECT s.instagram_account_id, k.value AS encrypted_token
      FROM stores s LEFT JOIN settings k ON k.store_id = s.id AND k.key = 'instagram_access_token'
      WHERE s.id = ?
    `).get(storeId) as any;
    const pageSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId) as any;
    const isInstagramLogin = Boolean(instagram?.instagram_account_id && instagram?.encrypted_token);
    const accessToken = isInstagramLogin
      ? this.decryptToken(String(instagram.encrypted_token))
      : decryptSettingSecret(String(pageSetting?.value || '')).trim();

    if (!instagram?.instagram_account_id || !accessToken) {
      console.warn(`[FacebookService] ⚠️ Instagram yorum yanıtı için hesap veya token eksik (Store: ${storeId}).`);
      return false;
    }

    try {
      const host = isInstagramLogin ? 'graph.instagram.com' : 'graph.facebook.com';
      const url = `https://${host}/v24.0/${encodeURIComponent(instagram.instagram_account_id)}/messages`;
      const res = await axios.post(url, {
        recipient: { comment_id: cleanCommentId },
        message: { text: sanitizedText }
      }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      console.log(`[FacebookService] 💬 Instagram yorumuna özel yanıt gönderildi -> ${cleanCommentId} (Store: ${storeId}, Status: ${res.status})`);
      return true;
    } catch (error: any) {
      const errDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
      console.error(`[FacebookService] ❌ Instagram yorumuna özel yanıt hatası (${cleanCommentId}):`, errDetails);
      return false;
    }
  }

  /** Fetches the caption of the post/reel that received the comment. */
  public static async getInstagramMediaContext(mediaId: string, storeId: number): Promise<{ id: string; caption: string; permalink: string } | null> {
    if (!Number.isInteger(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur.');
    }
    const cleanMediaId = String(mediaId || '').trim();
    if (!cleanMediaId) return null;

    const instagram = db.prepare(`
      SELECT s.instagram_account_id, k.value AS encrypted_token
      FROM stores s LEFT JOIN settings k ON k.store_id = s.id AND k.key = 'instagram_access_token'
      WHERE s.id = ?
    `).get(storeId) as any;
    const pageSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId) as any;
    const isInstagramLogin = Boolean(instagram?.instagram_account_id && instagram?.encrypted_token);
    const accessToken = isInstagramLogin
      ? this.decryptToken(String(instagram.encrypted_token))
      : decryptSettingSecret(String(pageSetting?.value || '')).trim();
    if (!accessToken) return null;

    try {
      const host = isInstagramLogin ? 'graph.instagram.com' : 'graph.facebook.com';
      const response = await axios.get(`https://${host}/v24.0/${encodeURIComponent(cleanMediaId)}`, {
        params: { fields: 'id,caption,permalink', access_token: accessToken },
        timeout: 10_000
      });
      return {
        id: String(response.data?.id || cleanMediaId),
        caption: String(response.data?.caption || '').trim(),
        permalink: String(response.data?.permalink || '').trim()
      };
    } catch (error: any) {
      const errDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
      console.warn(`[FacebookService] Instagram gönderi bağlamı alınamadı (${cleanMediaId}):`, errDetails);
      return null;
    }
  }
}
