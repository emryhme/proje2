import { db } from '../database/db';

export interface StockCheckResult {
  available: boolean;
  stock: number;
  reserved: number;
  netAvailable: number;
}

/**
 * Enterprise Multi-Tenant Inventory Management & Reservation Service
 */
export class InventoryService {
  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
  }

  /**
   * getStock - Fetches total, reserved, and net available stock for a product in a specific store (Strict Store Isolation)
   */
  public static getStock(storeId: number, productCode: string): StockCheckResult {
    const pCode = productCode.trim().toUpperCase();
    this.validateStoreId(storeId);
    
    // Check inventory table first for this exact store
    let inv = db.prepare('SELECT stock, reserved_stock FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, pCode) as any;
    
    if (!inv) {
      // Lookup in products table strictly scoped to storeId (No store_id = 1 fallback!)
      const prod = db.prepare('SELECT stock FROM products WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)').get(storeId, pCode, pCode) as any;
      const stock = prod ? Number(prod.stock) || 0 : 0;
      return { available: stock > 0, stock: stock, reserved: 0, netAvailable: stock };
    }

    const stock = Number(inv.stock) || 0;
    const reserved = Number(inv.reserved_stock) || 0;
    const net = Math.max(0, stock - reserved);

    return {
      available: net > 0,
      stock: stock,
      reserved: reserved,
      netAvailable: net
    };
  }

  /**
   * checkAvailability - Checks if requested quantity is available for storeId
   */
  public static checkAvailability(storeId: number, productCode: string, quantity: number): boolean {
    const pCode = productCode;
    const q = Number(quantity) || 1;
    this.validateStoreId(storeId);
    const res = this.getStock(storeId, pCode);
    return res.netAvailable >= Math.max(1, q);
  }

  /**
   * reserveStock - Temporarily reserves stock for cart / checkout (Strict Store Isolation)
   */
  public static reserveStock(storeId: number, productCode: string, quantity: number): boolean {
    const pCode = productCode.trim().toUpperCase();
    const q = Number(quantity) || 1;
    this.validateStoreId(storeId);

    if (!this.checkAvailability(storeId, pCode, q)) {
      return false;
    }

    let inv = db.prepare('SELECT id, reserved_stock FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, pCode) as any;

    if (inv) {
      db.prepare(`
        UPDATE inventory 
        SET reserved_stock = reserved_stock + ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(q, inv.id);
    } else {
      // Pull stock from products table
      const prod = db.prepare('SELECT stock FROM products WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)').get(storeId, pCode, pCode) as any;
      const prodStock = prod ? Number(prod.stock) || 0 : 0;

      db.prepare(`
        INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(storeId, pCode, prodStock, q);
    }
    return true;
  }

  /**
   * releaseStock - Releases temporary stock reservation for storeId
   */
  public static releaseStock(storeId: number, productCode: string, quantity: number): void {
    const pCode = productCode.trim().toUpperCase();
    const q = Number(quantity) || 1;
    this.validateStoreId(storeId);

    db.prepare(`
      UPDATE inventory 
      SET reserved_stock = MAX(0, reserved_stock - ?), updated_at = CURRENT_TIMESTAMP 
      WHERE store_id = ? AND UPPER(product_code) = ?
    `).run(q, storeId, pCode);
  }

  /**
   * deductStock - Permanently deducts stock upon order confirmation (Strict Store Isolation)
   */
  public static deductStock(storeId: number, productCode: string, quantity: number): boolean {
    const pCode = productCode.trim().toUpperCase();
    const q = Number(quantity) || 1;
    this.validateStoreId(storeId);

    const result = db.prepare(`
      UPDATE products 
      SET stock = MAX(0, stock - ?), updated_at = CURRENT_TIMESTAMP 
      WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
    `).run(q, storeId, pCode, pCode);

    // Synchronize inventory table
    db.prepare(`
      UPDATE inventory 
      SET stock = MAX(0, stock - ?), reserved_stock = MAX(0, reserved_stock - ?), updated_at = CURRENT_TIMESTAMP 
      WHERE store_id = ? AND UPPER(product_code) = ?
    `).run(q, q, storeId, pCode);

    return result.changes > 0;
  }

  /**
   * restoreStock - Restores stock upon order cancellation or return (Strict Store Isolation)
   */
  public static restoreStock(storeId: number, productCode: string, quantity: number): void {
    const pCode = productCode.trim().toUpperCase();
    const q = Number(quantity) || 1;
    this.validateStoreId(storeId);

    db.prepare(`
      UPDATE products 
      SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP 
      WHERE store_id = ? AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
    `).run(q, storeId, pCode, pCode);

    db.prepare(`
      UPDATE inventory 
      SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP 
      WHERE store_id = ? AND UPPER(product_code) = ?
    `).run(q, storeId, pCode);
  }
}
