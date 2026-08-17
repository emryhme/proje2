import axios from 'axios';
import { env } from '../config/env';
import { db } from '../database/db';
import { StockService } from './stock.service';
import { TelegramService } from './telegram.service';
import { FacebookService } from './facebook.service';

export interface OrderData {
  storeId?: number;
  customerName: string;
  customerPhone: string;
  address: string;
  productCode: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice?: number;
  shippingFee?: number;
  discount?: number;
  totalPrice?: number;
  senderId?: string;
}

export interface SavedOrder extends OrderData {
  orderId: string;
  createdAt: string;
  status?: string; // 'BEKLEMEDE' | 'OK' | 'DEC'
  senderId?: string;
  unitPrice?: number;
  shippingFee?: number;
  discount?: number;
  totalPrice?: number;
}

/**
 * SQLite (barons.db) Destekli Ultra Hızlı Multi-Tenant Sipariş Servisi
 */
export class OrderService {
  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
  }

  /**
   * Deterministik Temiz Sipariş Numarası Üreticisi
   */
  public static generateOrderId(productCode: string, size: string, phone: string): string {
    const cleanPhone = (phone || '').trim().replace(/\D/g, '');
    const lastThreePhone = cleanPhone.length >= 3 ? cleanPhone.slice(-3) : '000';
    
    const now = new Date();
    const minute = now.getMinutes().toString().padStart(2, '0');
    const second = now.getSeconds().toString().padStart(2, '0');
    const timeStamp = `${minute}${second}`;

    const rawCode = (productCode || '').trim();

    let baseCode = 'ORD';
    if (rawCode && !rawCode.includes(',') && !rawCode.includes(' ') && rawCode.length <= 15) {
      baseCode = rawCode.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
    }

    return `BRN-${baseCode}-${lastThreePhone}-${timeStamp}`;
  }

  /**
   * Sipariş oluşturur (Strict Store Isolation & Transaction Support)
   */
  public static async createOrder(storeId: number, data: OrderData): Promise<SavedOrder> {
    this.validateStoreId(storeId);

    const createdAt = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    const status = 'BEKLEMEDE';
    const senderId = data.senderId || '';

    const nameParts = data.customerName.trim().split(' ');
    const firstName = nameParts[0] || data.customerName;
    const lastName = nameParts.slice(1).join(' ') || '';

    const quantity = Math.max(1, Number(data.quantity) || 1);
    const pCode = StockService.normalizeLookupValue(data.productCode);
    const requestedSize = StockService.normalizeLookupValue(data.size);
    if (!pCode || !requestedSize) {
      throw new Error('PRODUCT_VARIANT_REQUIRED: Ürün kodu ve beden zorunludur.');
    }

    let canonicalProductCode = pCode;
    let canonicalProductName = data.productName || pCode;
    let orderId = '';

    let unitPrice = data.unitPrice || 0;
    let shippingFee = 0;
    let discount = 0;
    let totalPrice = 0;

    // Atomik Veritabanı İşlemi (Transaction-Safe Multi-Tenant Order Creation)
    const createOrderTx = db.transaction(() => {
      // 1. Store Var Olma Kontrolü
      const storeExists = db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
      if (!storeExists) {
        throw new Error(`STORE_NOT_FOUND: Store ID ${storeId} veritabanında bulunamadı.`);
      }

      // 2. Mağazaya Özel Ürün Fiyatı ve Stok Kontrolü
      const singleCode = pCode.split(/[,()]/)[0].trim();
      const resolvedProduct = StockService.findProductVariant(storeId, singleCode, requestedSize);
      const prodObj = resolvedProduct ? {
        id: resolvedProduct.id,
        product_code: resolvedProduct.productCode,
        name: resolvedProduct.name,
        size: resolvedProduct.size,
        price: resolvedProduct.price,
        stock: resolvedProduct.stock
      } : null;

      if (!prodObj || StockService.normalizeLookupValue(prodObj.size) !== requestedSize) {
        throw new Error(`PRODUCT_VARIANT_NOT_FOUND: ${singleCode}-${requestedSize} ürünü bulunamadı.`);
      }

      canonicalProductCode = String(prodObj.product_code).trim().toUpperCase();
      canonicalProductName = String(prodObj.name || data.productName || canonicalProductCode);
      orderId = this.generateOrderId(canonicalProductCode, requestedSize, data.customerPhone);

      if (prodObj && prodObj.price > 0) {
        unitPrice = prodObj.price; // Yetkili fiyat veritabanından alınır
      } else if (!unitPrice || unitPrice <= 0) {
        unitPrice = 299;
      }

      const availableStock = prodObj ? Number(prodObj.stock) || 0 : 0;
      if (availableStock < quantity) {
        throw new Error(`INSUFFICIENT_STOCK: İstenen ürün (${canonicalProductCode}) için yeterli stok bulunmuyor.`);
      }

      shippingFee = data.shippingFee !== undefined ? data.shippingFee : (unitPrice * quantity >= 1500 ? 0 : 49);
      discount = data.discount || 0;
      totalPrice = Math.max(0, (unitPrice * quantity) + shippingFee - discount);

      // 3. Stok Adedini Atomik Olarak Düş
      const stockRes = db.prepare(`
        UPDATE products 
        SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP 
        WHERE store_id = ? AND id = ? AND stock >= ?
      `).run(quantity, storeId, prodObj.id, quantity);

      if (stockRes.changes === 0) {
        throw new Error(`INSUFFICIENT_STOCK: Stok düşürme işlemi başarısız (Stok yetersiz veya çakışma var).`);
      }

      // Inventory senkronizasyonu
      try {
        db.prepare(`
          UPDATE inventory 
          SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP 
          WHERE store_id = ? AND product_code = ?
        `).run(quantity, storeId, canonicalProductCode);
      } catch (e) {}

      // 4. Siparişi Veritabanına Ekle
      const stmt = db.prepare(`
        INSERT INTO orders (order_id, store_id, store_name, first_name, last_name, customer_phone, address, product_code, product_name, size, quantity, unit_price, shipping_fee, discount, total_price, status, sender_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        orderId,
        storeId,
        'STORE-' + storeId,
        firstName,
        lastName,
        data.customerPhone,
        data.address,
        canonicalProductCode,
        canonicalProductName,
        requestedSize,
        quantity,
        unitPrice,
        shippingFee,
        discount,
        totalPrice,
        status,
        senderId,
        createdAt
      );

      // 5. Order Item Kaydı (order_items tablosu)
      try {
        db.prepare(`
          INSERT INTO order_items (order_id, store_id, product_id, product_name, sku, size, unit_price, quantity, total_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderId,
          storeId,
          prodObj ? prodObj.id : 0,
          canonicalProductName,
          canonicalProductCode,
          requestedSize,
          unitPrice,
          quantity,
          unitPrice * quantity
        );
      } catch (e) {}

      // 6. Müşteri Dizini Güncelleme (customers tablosu - Mağazaya özel)
      try {
        const custName = `${firstName} ${lastName}`.trim();
        const existingCust = db.prepare('SELECT id FROM customers WHERE store_id = ? AND (sender_id = ? OR phone = ?)').get(storeId, senderId || 'N/A', data.customerPhone) as any;
        if (existingCust) {
          db.prepare('UPDATE customers SET name = ?, phone = ?, address = ? WHERE store_id = ? AND id = ?').run(custName, data.customerPhone, data.address, storeId, existingCust.id);
        } else {
          db.prepare('INSERT INTO customers (store_id, sender_id, name, phone, address, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').run(storeId, senderId, custName, data.customerPhone, data.address);
        }
      } catch (e) {}

      return { unitPrice, shippingFee, discount, totalPrice };
    });

    const calcResult = createOrderTx();
    console.log(`[OrderService SQLite] 🛍️ Sipariş Veritabanına Atomik İşlemle Kaydedildi (Store: ${storeId}): ${orderId}`);

    return {
      orderId,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      address: data.address,
      productCode: canonicalProductCode,
      productName: canonicalProductName,
      size: requestedSize,
      quantity: quantity,
      unitPrice: calcResult.unitPrice,
      shippingFee: calcResult.shippingFee,
      discount: calcResult.discount,
      totalPrice: calcResult.totalPrice,
      createdAt,
      status,
      senderId
    };
  }

  /**
   * Siparişleri SQLite veritabanından mağaza bazında getirir (Strict Store Isolation).
   */
  public static async getOrders(storeId: number): Promise<SavedOrder[]> {
    this.validateStoreId(storeId);

    try {
      const stmt = db.prepare(`
        SELECT 
          order_id as orderId, 
          first_name, 
          last_name, 
          customer_phone as customerPhone, 
          address, 
          product_code as productCode, 
          product_name as productName, 
          size, 
          quantity, 
          unit_price as unitPrice,
          shipping_fee as shippingFee,
          discount,
          total_price as totalPrice,
          status, 
          sender_id as senderId, 
          created_at as createdAt
        FROM orders
        WHERE store_id = ?
        ORDER BY id DESC
      `);
      const rows = stmt.all(storeId) as any[];

      return rows.map(r => ({
        orderId: r.orderId,
        customerName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Müşteri',
        customerPhone: r.customerPhone,
        address: r.address,
        productCode: r.productCode,
        productName: r.productName || r.productCode,
        size: r.size,
        quantity: r.quantity,
        unitPrice: Number(r.unitPrice) || 0,
        shippingFee: Number(r.shippingFee) || 0,
        discount: Number(r.discount) || 0,
        totalPrice: Number(r.totalPrice) || 0,
        createdAt: r.createdAt,
        status: r.status,
        senderId: r.senderId || ''
      }));
    } catch (e: any) {
      console.error(`[OrderService SQLite] ❌ Siparişler çekilemedi (Store: ${storeId}):`, e.message);
      return [];
    }
  }

  /**
   * Mağazaya özel tek sipariş sorgulama
   */
  public static async getOrder(storeId: number, orderId: string): Promise<SavedOrder | null> {
    const targetOrderId = orderId;
    this.validateStoreId(storeId);

    const r = db.prepare(`
      SELECT 
        order_id as orderId, 
        first_name, 
        last_name, 
        customer_phone as customerPhone, 
        address, 
        product_code as productCode, 
        product_name as productName, 
        size, 
        quantity, 
        unit_price as unitPrice,
        shipping_fee as shippingFee,
        discount,
        total_price as totalPrice,
        status, 
        sender_id as senderId, 
        created_at as createdAt
      FROM orders
      WHERE store_id = ? AND order_id = ?
    `).get(storeId, targetOrderId) as any;

    if (!r) return null;

    return {
      orderId: r.orderId,
      customerName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Müşteri',
      customerPhone: r.customerPhone,
      address: r.address,
      productCode: r.productCode,
      productName: r.productName || r.productCode,
      size: r.size,
      quantity: r.quantity,
      unitPrice: Number(r.unitPrice) || 0,
      shippingFee: Number(r.shippingFee) || 0,
      discount: Number(r.discount) || 0,
      totalPrice: Number(r.totalPrice) || 0,
      createdAt: r.createdAt,
      status: r.status,
      senderId: r.senderId || ''
    };
  }

  /**
   * Sipariş Onay / Red İşlemi (Mağazaya Özel)
   */
  public static async updateOrderStatus(storeId: number, orderId: string, status: 'OK' | 'DEC', reason?: string): Promise<boolean> {
    const targetOrderId = orderId;
    const targetStatus = status;
    const targetReason = reason;
    this.validateStoreId(storeId);

    try {
      const existingOrder = db.prepare(`SELECT * FROM orders WHERE store_id = ? AND order_id = ?`).get(storeId, targetOrderId) as any;
      if (!existingOrder) {
        console.warn(`[OrderService SQLite] ⚠️ Güncellenecek sipariş bulunamadı veya yetkisiz erişim (Store: ${storeId}): ${targetOrderId}`);
        return false;
      }

      const prevStatus = (existingOrder.status || 'BEKLEMEDE').toUpperCase();
      const targetProductCode = existingOrder.product_code;
      const qty = Number(existingOrder.quantity) || 1;

      const stmt = db.prepare(`UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND order_id = ?`);
      const result = stmt.run(targetStatus, storeId, targetOrderId);

      if (result.changes > 0) {
        console.log(`[OrderService SQLite] ✅ Sipariş (${targetOrderId}) Durumu Güncellendi (Store: ${storeId}): ${prevStatus} -> ${targetStatus}`);

        if (targetStatus === 'DEC' && prevStatus !== 'DEC') {
          await StockService.restoreStock(storeId, targetProductCode, qty, existingOrder.size);
          const senderId = (existingOrder.sender_id || existingOrder.senderId || '').trim();
          if (senderId) {
            const customerName = `${existingOrder.first_name || ''} ${existingOrder.last_name || ''}`.trim() || 'Müşterimiz';
            const defaultReason = 'Siparişiniz operasyonel nedenlerle onaylanamamıştır.';
            const cleanReason = targetReason && targetReason.trim() ? targetReason.trim() : defaultReason;
            const dmMessage = `Sayın ${customerName},\n\nSiparişiniz (#${targetOrderId}) maalesef onaylanamamıştır.\n\nİptal / Red Nedeni:\n${cleanReason}\n\nAnlayışınız için teşekkür eder, keyifli günler dileriz. 🌸`;
            FacebookService.sendMessage(senderId, dmMessage, storeId).catch(() => {});
          }
        } else if (targetStatus === 'OK') {
          if (prevStatus === 'DEC') {
            await StockService.deductStock(storeId, targetProductCode, qty, existingOrder.size);
          }
          if (prevStatus !== 'OK') {
            const senderId = String(existingOrder.sender_id || existingOrder.senderId || '').trim();
            if (senderId) {
              const customerName = `${existingOrder.first_name || ''} ${existingOrder.last_name || ''}`.trim() || 'Müşterimiz';
              const productName = String(existingOrder.product_name || existingOrder.product_code || 'Ürününüz');
              const size = String(existingOrder.size || '').trim();
              const approvalMessage = `Sayın ${customerName},\n\n🎉 ${targetOrderId} numaralı siparişiniz onaylandı!\n\n📦 Ürün: ${productName}${size ? ` (${size} beden)` : ''}\n🔢 Adet: ${qty}\n\nSiparişiniz hazırlanarak kargo sürecine alınacaktır. Bizi tercih ettiğiniz için teşekkür ederiz. ✨`;
              const notificationSent = await FacebookService.sendMessage(senderId, approvalMessage, storeId);
              if (!notificationSent) {
                console.warn(`[OrderService] Sipariş onaylandı ancak Instagram DM gönderilemedi (Store: ${storeId}, Order: ${targetOrderId}).`);
              }
            } else {
              console.warn(`[OrderService] Sipariş onaylandı ancak sender_id boş olduğu için Instagram DM gönderilemedi (Store: ${storeId}, Order: ${targetOrderId}).`);
            }
          }
        }

        return true;
      }
      return false;
    } catch (e: any) {
      console.error(`[OrderService SQLite] ❌ Sipariş durumu güncellenemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }

  /**
   * Sipariş Silme (Mağazaya Özel)
   */
  public static async deleteOrder(storeId: number, orderId: string): Promise<boolean> {
    const targetOrderId = orderId;
    this.validateStoreId(storeId);

    try {
      const existingOrder = db.prepare(`SELECT * FROM orders WHERE store_id = ? AND order_id = ?`).get(storeId, targetOrderId) as any;
      if (!existingOrder) {
        return false;
      }

      const stmt = db.prepare(`DELETE FROM orders WHERE store_id = ? AND order_id = ?`);
      const result = stmt.run(storeId, targetOrderId);

      if (result.changes > 0) {
        try {
          db.prepare('DELETE FROM order_items WHERE store_id = ? AND order_id = ?').run(storeId, targetOrderId);
        } catch (e) {}

        if (existingOrder.status !== 'DEC') {
          await StockService.restoreStock(storeId, existingOrder.product_code, Number(existingOrder.quantity) || 1, existingOrder.size);
        }

        return true;
      }
      return false;
    } catch (e: any) {
      console.error(`[OrderService SQLite] ❌ Sipariş silinemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }
}
