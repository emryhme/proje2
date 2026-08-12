import axios from 'axios';
import { db } from '../database/db';
import { SavedOrder } from './order.service';

/**
 * Telegram Bildirim Servisi (İşletme Sahibi & Müşteri Bildirimleri)
 */
export class TelegramService {
  private static getStoreCredentials(storeId: number): { botToken: string; chatId: string } | null {
    if (!Number.isInteger(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur.');
    }

    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('telegram_bot_token', 'telegram_chat_id')
    `).all(storeId) as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value?.trim()]));
    const botToken = values.get('telegram_bot_token') || '';
    const chatId = values.get('telegram_chat_id') || '';
    return botToken && chatId ? { botToken, chatId } : null;
  }

  /**
   * Yeni sipariş düştüğünde işletme sahibine HTML bildirim mesajı atar.
   */
  public static async notifyOrder(storeId: number, order: SavedOrder): Promise<boolean> {
    const credentials = this.getStoreCredentials(storeId);
    if (!credentials) {
      console.warn('[TelegramService] ⚠️ Bot Token veya Chat ID tanımlı değil, bildirim atlanıyor.');
      return false;
    }

    const messageHtml = `
🛍️ <b>YENİ SİPARİŞ BİLDİRİMİ</b>

• <b>Müşteri:</b> ${this.escapeHtml(order.customerName)}
• <b>Ürün İsmi:</b> ${this.escapeHtml(order.productName)}
• <b>Ürün Kodu:</b> <code>${this.escapeHtml(order.productCode)}</code>
• <b>Beden:</b> ${this.escapeHtml(order.size)}
• <b>Adet:</b> ${order.quantity}
• <b>Adres:</b> ${this.escapeHtml(order.address)}
• <b>Telefon:</b> ${this.escapeHtml(order.customerPhone)}
• <b>Tarih:</b> ${order.createdAt}
• <b>SİPARİŞ NUMARASI:</b> <code>${order.orderId}</code>

<i>Onaylamak için sipariş numarası ile ONAY veya RED yazınız.</i>
    `.trim();

    try {
      const url = `https://api.telegram.org/bot${credentials.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: credentials.chatId,
        text: messageHtml,
        parse_mode: 'HTML'
      });
      console.log(`[TelegramService] 📲 Sipariş bildirimi Telegram'a gönderildi: ${order.orderId}`);
      return true;
    } catch (error: any) {
      console.error('[TelegramService] ❌ Telegram bildirimi gönderilemedi:', error?.response?.data || error.message);
      return false;
    }
  }

  /**
   * Sipariş Onaylandığında Müşteriye / Grubuna 'Siparişiniz Onaylandı' Mesajı Gönderir.
   */
  public static async sendCustomerApprovalNotification(storeId: number, order: SavedOrder): Promise<boolean> {
    const messageHtml = `
🎉 <b>SİPARİŞİNİZ ONAYLANDI!</b>

Sayın <b>${this.escapeHtml(order.customerName)}</b>,
<code>${order.orderId}</code> numaralı siparişiniz başarıyla onaylanmıştır!

📦 <b>Ürün:</b> ${this.escapeHtml(order.productName || order.productCode)} (${order.size} Beden)
🔢 <b>Adet:</b> ${order.quantity}
📍 <b>Teslimat Adresi:</b> ${this.escapeHtml(order.address)}

Siparişiniz kargo birimine sevk edilmiş olup en kısa sürede adresinize teslim edilecektir. BARON'S SILLAGE'i tercih ettiğiniz için teşekkür ederiz! ✨
    `.trim();

    console.log(`[Customer Notification] 📩 Müşteriye Sipariş Onay Mesajı Yollandı (${order.customerName} - ${order.customerPhone}):`);
    console.log(messageHtml);

    const credentials = this.getStoreCredentials(storeId);
    if (credentials) {
      try {
        const url = `https://api.telegram.org/bot${credentials.botToken}/sendMessage`;
        await axios.post(url, {
          chat_id: credentials.chatId,
          text: messageHtml,
          parse_mode: 'HTML'
        });
        return true;
      } catch (e: any) {
        console.warn('[TelegramService] Müşteri onay mesajı gönderilemedi:', e.message);
      }
    }
    return true;
  }

  private static escapeHtml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
