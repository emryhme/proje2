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
}
