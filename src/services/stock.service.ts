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
  instagramMediaId?: string;
  storeId?: number;
}

export interface ProductVariantRow extends ProductStockRow {
  id: number;
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

  public static normalizeLookupValue(value: unknown): string {
    return String(value ?? '')
      .normalize('NFKC')
      .trim()
      .toLocaleUpperCase('tr-TR')
      .replace(/[‐‑‒–—−]/g, '-')
      .replace(/[._/\\]+/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ');
  }

  private static compactLookupValue(value: unknown): string {
    return this.normalizeLookupValue(value).replace(/[\s-]+/g, '');
  }

  public static containsLookupValue(text: unknown, value: unknown): boolean {
    const normalizedText = this.normalizeLookupValue(text);
    const normalizedValue = this.normalizeLookupValue(value);
    if (!normalizedText || !normalizedValue) return false;
    const pieces = normalizedValue.split(/[\s-]+/).filter(Boolean).map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!pieces.length) return false;
    const pattern = pieces.join('[\\s-]+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(normalizedText);
  }

  /** Resolves a product variant in JavaScript so Turkish characters are not lost by SQLite UPPER(). */
  public static findProductVariant(storeId: number, productCode: string, size?: string): ProductVariantRow | null {
    this.validateStoreId(storeId);
    const codeKey = this.compactLookupValue(productCode);
    const sizeKey = this.compactLookupValue(size || '');
    if (!codeKey) return null;
    const rows = db.prepare(`
      SELECT id, short_code as shortCode, product_code as productCode, name, color, size, price, stock, category,
             instagram_media_id as instagramMediaId, store_id as storeId
      FROM products WHERE store_id = ? ORDER BY id ASC
    `).all(storeId) as ProductVariantRow[];
    const sizeMatches = (row: ProductVariantRow) => !sizeKey || this.compactLookupValue(row.size) === sizeKey;
    return rows.find(row => this.compactLookupValue(row.productCode) === codeKey && sizeMatches(row))
      || rows.find(row => this.compactLookupValue(row.shortCode) === codeKey && sizeMatches(row))
      || null;
  }

  /**
   * SQLite veritabanındaki mağazaya özel ürün satırlarını getirir.
   */
  public static async fetchAllSheetRows(storeId: number): Promise<ProductStockRow[]> {
    this.validateStoreId(storeId);
    try {
      const stmt = db.prepare(`
        SELECT short_code as shortCode, product_code as productCode, name, color, size, price, stock, category,
               instagram_media_id as instagramMediaId, store_id as storeId
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
    const rawQuery = this.normalizeLookupValue(queryInput);
    this.validateStoreId(storeId);
    const rows = await this.fetchAllSheetRows(storeId);

    if (rows.length === 0) {
      return { exists: false, inStock: false };
    }

    const summarizeVariants = (variantRows: ProductStockRow[], familyCode: string) => {
      const variants = variantRows.map(row => ({
        productCode: row.productCode,
        size: row.size,
        color: row.color,
        stock: Number(row.stock) || 0,
        price: Number(row.price)
      }));
      const totalStock = variants.reduce((sum, variant) => sum + variant.stock, 0);
      const availableSizes = [...new Set(variants.filter(variant => variant.stock > 0).map(variant => variant.size).filter(Boolean))];
      return {
        exists: true,
        inStock: totalStock > 0,
        product: {
          productCode: familyCode,
          name: variantRows[0]?.name || familyCode,
          stock: totalStock,
          availableSizes,
          variants
        }
      };
    };

    // 1. Doğrudan ÜRÜN KODU Eşleşmesi
    let match = rows
      .slice()
      .sort((a, b) => String(b.productCode || '').length - String(a.productCode || '').length)
      .find(r => this.containsLookupValue(rawQuery, r.productCode));

    // 2. Kısa Kod + Beden ayrıştırma
    if (!match) {
      match = rows.find(r => {
        return this.containsLookupValue(rawQuery, `${r.shortCode}-${r.size}`);
      });
    }

    // 3. Kısa Kod Eşleşmesi
    if (!match) {
      const shortMatch = rows.find(r => this.containsLookupValue(rawQuery, r.shortCode));
      if (shortMatch) {
        const shortCode = this.normalizeLookupValue(shortMatch.shortCode);
        const shortMatches = rows.filter(r => this.compactLookupValue(r.shortCode) === this.compactLookupValue(shortCode));
        return summarizeVariants(shortMatches, shortCode);
      }
    }

    // 4. İsim İle Arama
    if (!match) {
      const nameMatches = rows.filter(r => {
        const name = this.normalizeLookupValue(r.name);
        return name.includes(rawQuery) || rawQuery.includes(name);
      });
      if (nameMatches.length > 1) {
        return summarizeVariants(nameMatches, this.normalizeLookupValue(nameMatches[0].shortCode || nameMatches[0].name));
      }
      match = nameMatches[0];
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
    instagramMediaId?: string;
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
      const instagramMediaId = String(data.instagramMediaId || '').trim().slice(0, 128);

      const addProductTx = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM products WHERE store_id = ? AND (product_code = ? OR (short_code = ? AND size = ?))').get(storeId, productCode, shortCode, size) as any;

        if (existing) {
          db.prepare(`
            UPDATE products 
            SET name = ?, color = ?, size = ?, stock = ?, price = ?, category = ?, store_name = ?, instagram_media_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE store_id = ? AND id = ?
          `).run(name, color, size, stock, price, category, storeName, instagramMediaId, storeId, existing.id);
        } else {
          db.prepare(`
            INSERT INTO products (short_code, product_code, name, color, size, stock, price, category, store_name, instagram_media_id, store_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(shortCode, productCode, name, color, size, stock, price, category, storeName, instagramMediaId, storeId);
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
