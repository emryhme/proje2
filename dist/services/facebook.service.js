"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FacebookService = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../database/db");
const env_1 = require("../config/env");
/**
 * Facebook Graph API (Instagram DM / Messenger) Yanıt Gönderme Servisi (Store Scoped)
 */
class FacebookService {
    static decryptToken(value) {
        const [version, ivText, encryptedText, authTagText] = value.split(':');
        if (version !== 'v1' || !ivText || !encryptedText || !authTagText) {
            throw new Error('Geçersiz Instagram erişim anahtarı biçimi.');
        }
        const key = crypto_1.default.createHash('sha256').update(`${env_1.env.jwtSecret}:instagram-token-v1`).digest();
        const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
        decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    }
    /**
     * Müşteriye yanıt mesajı gönderir (Per-Store Credential Support).
     */
    static async sendMessage(recipientId, text, storeId) {
        if (!Number.isInteger(storeId) || storeId <= 0) {
            throw new Error('Store ID zorunludur.');
        }
        const instagram = db_1.db.prepare(`
      SELECT s.instagram_account_id, k.value AS encrypted_token
      FROM stores s LEFT JOIN settings k ON k.store_id = s.id AND k.key = 'instagram_access_token'
      WHERE s.id = ?
    `).get(storeId);
        const setting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId);
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
            const res = await axios_1.default.post(url, {
                recipient: isInstagramLogin ? { id: recipientId } : { id: recipientId },
                message: { text: sanitizedText }
            }, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[FacebookService] 📤 Mesaj başarıyla gönderildi -> ${recipientId} (Store: ${storeId || 'default'}, Status: ${res.status})`);
            return true;
        }
        catch (error) {
            const errDetails = error?.response?.data ? JSON.stringify(error.response.data) : error.message;
            console.error(`[FacebookService] ❌ Mesaj gönderim hatası (${recipientId}):`, errDetails);
            return false;
        }
    }
}
exports.FacebookService = FacebookService;
