"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FacebookService = void 0;
const axios_1 = __importDefault(require("axios"));
const db_1 = require("../database/db");
/**
 * Facebook Graph API (Instagram DM / Messenger) Yanıt Gönderme Servisi (Store Scoped)
 */
class FacebookService {
    /**
     * Müşteriye yanıt mesajı gönderir (Per-Store Credential Support).
     */
    static async sendMessage(recipientId, text, storeId) {
        if (!Number.isInteger(storeId) || storeId <= 0) {
            throw new Error('Store ID zorunludur.');
        }
        const setting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'facebook_page_access_token'").get(storeId);
        const accessToken = String(setting?.value || '').trim();
        if (!accessToken) {
            console.warn(`[FacebookService] ⚠️ FB Page Access Token eksik (Store: ${storeId || 'default'}), mesaj konsola yazdırılıyor:`);
            console.log(`[FB Mock -> ${recipientId}]: ${text}`);
            return false;
        }
        const sanitizedText = text ? text.trim() : '';
        try {
            const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(accessToken)}`;
            const res = await axios_1.default.post(url, {
                recipient: { id: recipientId },
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
