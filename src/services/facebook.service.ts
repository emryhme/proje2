import axios from 'axios';
import crypto from 'crypto';
import { db } from '../database/db';
import { env } from '../config/env';

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
    let accessToken = String(setting?.value || '').trim();
    if (isInstagramLogin) {
      accessToken = this.decryptToken(String(instagram.encrypted_token));
    }

    if (!accessToken) {
      console.warn(`[FacebookService] ⚠️ FB Page Access Token eksik (Store: ${storeId || 'default'}), mesaj konsola yazdırılıyor:`);
      console.log(`[FB Mock -> ${recipientId}]: ${text}`);
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
      : String(pageSetting?.value || '').trim();

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
      : String(pageSetting?.value || '').trim();
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
