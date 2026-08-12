import { db } from '../database/db';

export interface ProductStockRow {
  shortCode: string;   // KISA KOD (Örn: KGMLW)
  productCode: string; // ÜRÜN KODU (Örn: KGMLW-M)
  name: string;        // ÜRÜN İSMİ (Örn: KUMAŞ GÖMLEK)
  color: string;       // RENK (Örn: BEYAZ)
  size: string;        // NUMARA/BEDEN (Örn: M)
  price: number;       // FİYAT (Örn: 299)
  stock: number;       // STOK (Örn: 5)
  category: string;    // KATEGORİ (Örn: GÖMLEK)
  storeId?: number;
}

/**
 * SQLite (barons.db) Destekli Ultra Hızlı Multi-Tenant Stok Yönetim Servisi
 */
export class StockService {
  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
  }

  /**
   * SQLite veritabanındaki mağazaya özel ürün satırlarını getirir.
   */
  public static async fetchAllSheetRows(storeId: number): Promise<ProductStockRow[]> {
    this.validateStoreId(storeId);
    try {
      const stmt = db.prepare(`
        SELECT short_code as shortCode, product_code as productCode, name, color, size, price, stock, category, store_id as storeId
        FROM products
        WHERE store_id = ?
        ORDER BY id ASC
      `);
      return stmt.all(storeId) as ProductStockRow[];
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Ürünler okunamadı (Store: ${storeId}):`, e.message);
      return [];
    }
  }

  /**
   * Mağazaya özel benzersiz ürünlerin güncel stok listesini getirir.
   */
  public static async getAllProducts(storeId: number): Promise<ProductStockRow[]> {
    return await this.fetchAllSheetRows(storeId);
  }

  /**
   * Mağaza bazında akıllı stok sorgulama yapar.
   */
  public static async checkStock(storeId: number, queryInput: string): Promise<{ exists: boolean; inStock: boolean; product?: any }> {
    const rawQuery = queryInput.trim().toUpperCase();
    this.validateStoreId(storeId);
    const rows = await this.fetchAllSheetRows(storeId);

    if (rows.length === 0) {
      return { exists: false, inStock: false };
    }

    // 1. Doğrudan ÜRÜN KODU Eşleşmesi
    let match = rows.find(r => r.productCode.toUpperCase() === rawQuery || rawQuery.includes(r.productCode.toUpperCase()));

    // 2. Kısa Kod + Beden ayrıştırma
    if (!match) {
      match = rows.find(r => {
        const pattern1 = `${r.shortCode}-${r.size}`.toUpperCase();
        const pattern2 = `${r.shortCode} ${r.size}`.toUpperCase();
        return rawQuery.includes(pattern1) || rawQuery.includes(pattern2);
      });
    }

    // 3. Kısa Kod Eşleşmesi
    if (!match) {
      const shortMatch = rows.find(r => rawQuery.includes(r.shortCode.toUpperCase()));
      if (shortMatch) {
        const shortCode = shortMatch.shortCode.toUpperCase();
        const shortMatches = rows.filter(r => r.shortCode.toUpperCase() === shortCode);
        const hasStock = shortMatches.some(r => r.stock > 0);
        const availableSizes = shortMatches.filter(r => r.stock > 0).map(r => r.size);
        return {
          exists: true,
          inStock: hasStock,
          product: {
            productCode: shortCode,
            name: shortMatch.name,
            availableSizes,
            stock: hasStock ? 1 : 0
          }
        };
      }
    }

    // 4. İsim İle Arama
    if (!match) {
      match = rows.find(r => r.name.toUpperCase().includes(rawQuery) || rawQuery.includes(r.name.toUpperCase()));
    }

    if (!match) {
      return { exists: false, inStock: false };
    }

    return {
      exists: true,
      inStock: match.stock > 0,
      product: {
        productCode: match.productCode,
        name: `${match.name} (${match.size})`,
        stock: match.stock,
        size: match.size,
        price: match.price
      }
    };
  }

  /**
   * Stok Eksiltme (Mağazaya Özel)
   */
  public static async deductStock(storeId: number, productCode: string, quantity: number, size?: string): Promise<boolean> {
    const targetSize = size ? size.trim().toUpperCase() : '';
    this.validateStoreId(storeId);
    try {
      const targetCode = productCode.trim().toUpperCase();

      let stmt;
      let result;

      if (targetCode.includes('-')) {
        stmt = db.prepare(`
          UPDATE products
          SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR (UPPER(short_code) = ? AND UPPER(size) = ?))
        `);
        const parts = targetCode.split('-');
        result = stmt.run(quantity, storeId, targetCode, parts[0], parts[1] || targetSize);
      } else if (targetSize) {
        const fullCode = `${targetCode}-${targetSize}`;
        stmt = db.prepare(`
          UPDATE products
          SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR (UPPER(short_code) = ? AND UPPER(size) = ?))
        `);
        result = stmt.run(quantity, storeId, fullCode, targetCode, targetSize);
      } else {
        stmt = db.prepare(`
          UPDATE products
          SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
        `);
        result = stmt.run(quantity, storeId, targetCode, targetCode);
      }

      // Synchronize inventory table
      try {
        db.prepare(`
          UPDATE inventory 
          SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP 
          WHERE store_id = ? AND UPPER(product_code) = ?
        `).run(quantity, storeId, targetCode);
      } catch (e) {}

      console.log(`[StockService SQLite] 📦 Stok Düşüldü (Store: ${storeId}, ${targetCode}): -${quantity} (Etkilenen Satır: ${result.changes})`);

      return result.changes > 0;
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Stok düşülemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }

  /**
   * Stok İade Etme / Artırma (Mağazaya Özel)
   */
  public static async restoreStock(storeId: number, productCode: string, quantity: number, size?: string): Promise<boolean> {
    const targetSize = size ? size.trim().toUpperCase() : '';
    this.validateStoreId(storeId);
    try {
      const targetCode = productCode.trim().toUpperCase();

      let stmt;
      let result;

      if (targetCode.includes('-')) {
        stmt = db.prepare(`
          UPDATE products
          SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR (UPPER(short_code) = ? AND UPPER(size) = ?))
        `);
        const parts = targetCode.split('-');
        result = stmt.run(quantity, storeId, targetCode, parts[0], parts[1] || targetSize);
      } else if (targetSize) {
        const fullCode = `${targetCode}-${targetSize}`;
        stmt = db.prepare(`
          UPDATE products
          SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR (UPPER(short_code) = ? AND UPPER(size) = ?))
        `);
        result = stmt.run(quantity, storeId, fullCode, targetCode, targetSize);
      } else {
        stmt = db.prepare(`
          UPDATE products
          SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP
          WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
        `);
        result = stmt.run(quantity, storeId, targetCode, targetCode);
      }

      // Synchronize inventory table
      try {
        db.prepare(`
          UPDATE inventory 
          SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP 
          WHERE store_id = ? AND UPPER(product_code) = ?
        `).run(quantity, storeId, targetCode);
      } catch (e) {}

      console.log(`[StockService SQLite] 🔄 Stok İade Edildi (Store: ${storeId}, ${targetCode}): +${quantity}`);

      return result.changes > 0;
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Stok iade edilemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }

  /**
   * SQLite Veritabanına Yeni Ürün Ekler veya Günceller (Store ID Zorunlu)
   */
  public static async addProduct(data: {
    storeId?: number;
    shortCode: string;
    productCode?: string;
    name: string;
    color?: string;
    size: string;
    stock: number;
    price?: number;
    category?: string;
    storeName?: string;
  }): Promise<{ success: boolean; productCode: string }>;
  public static async addProduct(data: any): Promise<{ success: boolean; productCode: string }> {
    this.validateStoreId(data?.storeId);
    try {
      const storeId = data.storeId;
      const shortCode = String(data.shortCode || '').trim().toUpperCase();
      const size = String(data.size || '').trim().toUpperCase();
      const productCode = data.productCode && data.productCode.trim() !== '' 
        ? data.productCode.trim().toUpperCase() 
        : `${shortCode}-${size}`;
      const name = String(data.name || '').trim();
      const color = (data.color || 'Standart').trim();
      const stock = Math.max(0, Number(data.stock) || 0);
      const price = Number(data.price) || 299;
      const category = (data.category || 'Genel').trim();
      const storeName = (data.storeName || '').trim();

      const addProductTx = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM products WHERE store_id = ? AND (product_code = ? OR (short_code = ? AND size = ?))').get(storeId, productCode, shortCode, size) as any;

        if (existing) {
          db.prepare(`
            UPDATE products 
            SET name = ?, color = ?, size = ?, stock = ?, price = ?, category = ?, store_name = ?, updated_at = CURRENT_TIMESTAMP
            WHERE store_id = ? AND id = ?
          `).run(name, color, size, stock, price, category, storeName, storeId, existing.id);
        } else {
          db.prepare(`
            INSERT INTO products (short_code, product_code, name, color, size, stock, price, category, store_name, store_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(shortCode, productCode, name, color, size, stock, price, category, storeName, storeId);
        }

        // Synchronize inventory table atomically
        let inv = db.prepare('SELECT id FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, productCode) as any;
        if (inv) {
          db.prepare('UPDATE inventory SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stock, inv.id);
        } else {
          db.prepare('INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)').run(storeId, productCode, stock);
        }
      });

      addProductTx();

      console.log(`[StockService SQLite] ✅ Ürün eklendi/güncellendi (Store: ${storeId}): ${productCode} (Stok: ${stock}, Fiyat: ${price} TL)`);
      return { success: true, productCode };
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Ürün eklenemedi:`, e.message);
      return { success: false, productCode: data.productCode || data.shortCode };
    }
  }

  /**
   * SQLite Veritabanından Ürün Siler (Mağazaya Özel)
   */
  public static async deleteProduct(storeId: number, productCode: string): Promise<boolean> {
    const targetCode = productCode;
    this.validateStoreId(storeId);
    try {
      const target = targetCode.trim().toUpperCase();
      const stmt = db.prepare(`DELETE FROM products WHERE store_id = ? AND (product_code = ? OR short_code = ?)`);
      const res = stmt.run(storeId, target, target);

      // Synchronize inventory table
      try {
        db.prepare(`DELETE FROM inventory WHERE store_id = ? AND (product_code = ? OR product_code LIKE ?)`).run(storeId, target, `${target}-%`);
      } catch (e) {}

      console.log(`[StockService SQLite] 🗑️ Ürün silindi (Store: ${storeId}): ${target}`);

      return res.changes > 0;
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Ürün silinemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }

  /**
   * SQLite Veritabanında Ürün Stok Miktarını Günceller (Mağazaya Özel)
   */
  public static async updateStock(storeId: number, productCode: string, newStock: number): Promise<boolean> {
    const targetCode = productCode.trim().toUpperCase();
    const stockNum = Number(newStock);
    this.validateStoreId(storeId);

    if (isNaN(stockNum) || stockNum < 0) {
      console.warn(`[StockService SQLite] ❌ Geçersiz stok miktarı (Store: ${storeId}): ${newStock}`);
      return false;
    }

    try {
      const target = targetCode.trim().toUpperCase();
      const stmt = db.prepare(`
        UPDATE products
        SET stock = ?, updated_at = CURRENT_TIMESTAMP
        WHERE store_id = ? AND (product_code = ? OR short_code = ?)
      `);
      const res = stmt.run(stockNum, storeId, target, target);

      if (res.changes === 0) {
        return false;
      }

      // Synchronize inventory table
      try {
        let inv = db.prepare('SELECT id FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, target) as any;
        if (inv) {
          db.prepare('UPDATE inventory SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stockNum, inv.id);
        } else {
          db.prepare('INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)').run(storeId, target, stockNum);
        }
      } catch (e) {}

      console.log(`[StockService SQLite] 📦 Ürün (${target}) Stoğu Güncellendi (Store: ${storeId}): ${stockNum}`);

      return res.changes > 0;
    } catch (e: any) {
      console.error(`[StockService SQLite] ❌ Ürün stoğu güncellenemedi (Store: ${storeId}):`, e.message);
      return false;
    }
  }
}
