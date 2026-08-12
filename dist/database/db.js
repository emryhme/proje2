"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.initDatabase = initDatabase;
exports.createMerchantApplication = createMerchantApplication;
exports.getAllMerchantApplications = getAllMerchantApplications;
exports.approveMerchantApplication = approveMerchantApplication;
exports.rejectMerchantApplication = rejectMerchantApplication;
exports.findMerchantApplicationByIdentifier = findMerchantApplicationByIdentifier;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.needsPasswordRehash = needsPasswordRehash;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
/**
 * BARON'S SILLAGE SQLite Veritabanı Yöneticisi (barons.db)
 */
const dbPath = path_1.default.resolve(process.cwd(), env_1.env.databasePath);
fs_1.default.mkdirSync(path_1.default.dirname(dbPath), { recursive: true });
console.log(`[Database] 🗄️ SQLite Veritabanı Yolu: ${dbPath}`);
exports.db = new better_sqlite3_1.default(dbPath, { verbose: undefined });
// Performans Ayarları (WAL Mode & Synchronous Normal)
exports.db.pragma('foreign_keys = ON');
exports.db.pragma('journal_mode = WAL');
exports.db.pragma('synchronous = NORMAL');
function hasColumn(table, column) {
    return exports.db.prepare(`PRAGMA table_info(${table})`).all()
        .some((existing) => existing.name === column);
}
function addColumnIfMissing(table, column, definition) {
    if (!hasColumn(table, column)) {
        exports.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}
function runSchemaMigrations() {
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    const migrations = [{
            version: '20260812_001_tenant_and_meta_columns',
            name: 'Add tenant and Meta integration columns',
            up: () => {
                addColumnIfMissing('products', 'price', 'REAL NOT NULL DEFAULT 299.00');
                addColumnIfMissing('products', 'store_name', "TEXT DEFAULT ''");
                addColumnIfMissing('products', 'store_id', 'INTEGER NOT NULL DEFAULT 1');
                addColumnIfMissing('orders', 'unit_price', 'REAL NOT NULL DEFAULT 0');
                addColumnIfMissing('orders', 'shipping_fee', 'REAL NOT NULL DEFAULT 0');
                addColumnIfMissing('orders', 'discount', 'REAL NOT NULL DEFAULT 0');
                addColumnIfMissing('orders', 'total_price', 'REAL NOT NULL DEFAULT 0');
                addColumnIfMissing('orders', 'sender_id', "TEXT DEFAULT ''");
                addColumnIfMissing('orders', 'store_name', "TEXT DEFAULT ''");
                addColumnIfMissing('orders', 'store_id', 'INTEGER NOT NULL DEFAULT 1');
                addColumnIfMissing('campaigns', 'start_date', 'TEXT DEFAULT NULL');
                addColumnIfMissing('campaigns', 'end_date', 'TEXT DEFAULT NULL');
                addColumnIfMissing('campaigns', 'store_name', "TEXT DEFAULT ''");
                addColumnIfMissing('campaigns', 'store_id', 'INTEGER NOT NULL DEFAULT 1');
                addColumnIfMissing('user_rewards', 'store_name', "TEXT DEFAULT ''");
                addColumnIfMissing('user_rewards', 'store_id', 'INTEGER NOT NULL DEFAULT 1');
                addColumnIfMissing('webhook_events', 'store_id', 'INTEGER NOT NULL DEFAULT 1');
                addColumnIfMissing('stores', 'webhook_verify_token', "TEXT DEFAULT ''");
                addColumnIfMissing('stores', 'meta_page_id', "TEXT DEFAULT ''");
                addColumnIfMissing('stores', 'instagram_account_id', "TEXT DEFAULT ''");
                addColumnIfMissing('stores', 'instagram_username', "TEXT DEFAULT ''");
                addColumnIfMissing('stores', 'last_webhook_at', 'TEXT DEFAULT NULL');
                exports.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_webhook_events_store_event ON webhook_events(store_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_stores_meta_page ON stores(meta_page_id);
        CREATE INDEX IF NOT EXISTS idx_stores_ig_account ON stores(instagram_account_id);
      `);
            }
        }, {
            version: '20260812_002_api_key_lifecycle',
            name: 'Add API key expiration and revocation fields',
            up: () => {
                addColumnIfMissing('api_keys', 'expires_at', 'TEXT DEFAULT NULL');
                addColumnIfMissing('api_keys', 'revoked_at', 'TEXT DEFAULT NULL');
                exports.db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(store_id, revoked_at, expires_at);');
            }
        }, {
            version: '20260812_003_webhook_events_per_store',
            name: 'Scope webhook idempotency keys to each store',
            up: () => {
                const schema = exports.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'").get();
                if (schema?.sql?.includes('PRIMARY KEY (store_id, event_id)'))
                    return;
                exports.db.exec(`
        CREATE TABLE webhook_events_new (
          event_id TEXT NOT NULL,
          store_id INTEGER NOT NULL,
          store_slug TEXT DEFAULT '',
          processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (store_id, event_id),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO webhook_events_new (event_id, store_id, store_slug, processed_at)
        SELECT event_id, COALESCE(store_id, 1), COALESCE(store_slug, ''), processed_at
        FROM webhook_events;
        DROP TABLE webhook_events;
        ALTER TABLE webhook_events_new RENAME TO webhook_events;
        CREATE INDEX IF NOT EXISTS idx_webhook_events_store_event ON webhook_events(store_id, event_id);
      `);
            }
        }];
    const isApplied = exports.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
    const markApplied = exports.db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
    for (const migration of migrations) {
        if (isApplied.get(migration.version))
            continue;
        exports.db.transaction(() => {
            migration.up();
            markApplied.run(migration.version, migration.name);
        })();
    }
}
/**
 * Tabloları Oluşturur (Migrations)
 */
function initDatabase() {
    // 1. Ürünler Tablosu (products)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_code TEXT NOT NULL,
      product_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '',
      size TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 299.00,
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT DEFAULT '',
      wp_link TEXT DEFAULT '',
      media_link TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 2. Siparişler Tablosu (orders)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT DEFAULT '',
      customer_phone TEXT NOT NULL,
      address TEXT NOT NULL,
      product_code TEXT NOT NULL,
      product_name TEXT DEFAULT '',
      size TEXT DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      shipping_fee REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'BEKLEMEDE',
      sender_id TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 3. Kampanyalar Tablosu (campaigns)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      code TEXT DEFAULT '',
      discount_percent REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      min_order_amount REAL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 4. Sistem Ayarları Tablosu (settings - Kargo Fiyatları vb.)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
    // 5. Müşteri Kişiye Özel İndirim Ödülleri Tablosu (user_rewards - Instagram ID'ye özel %20 İndirim)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS user_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      reward_code TEXT NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 20.0,
      min_qualifying_amount REAL NOT NULL DEFAULT 2000.0,
      is_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      used_at TEXT DEFAULT NULL
    );
  `);
    // 6. Üye / Mağaza Başvuruları Tablosu (merchant_applications)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      store_name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'Pro Store (₺6.000 / Ay)',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 7. Webhook Mükerrer İşleme Engelleyici Tablo (webhook_events - Idempotency)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      store_slug TEXT DEFAULT '',
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 8. Multi-Tenant Stores Tablosu
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 9. Users Tablosu
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      tc_no TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 10. Memberships (Store-User RBAC Roles)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      store_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'OWNER',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, store_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_store ON memberships(user_id, store_id);
  `);
    // 11. Product Variants (SKU & Size/Color Level)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER DEFAULT 0,
      store_id INTEGER NOT NULL DEFAULT 1,
      sku TEXT NOT NULL,
      color TEXT DEFAULT 'Standart',
      size TEXT DEFAULT 'M',
      price REAL NOT NULL DEFAULT 299.00,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 12. Inventory (Dedicated Stock & Reservation)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER DEFAULT 0,
      product_code TEXT NOT NULL,
      store_id INTEGER NOT NULL DEFAULT 1,
      stock INTEGER NOT NULL DEFAULT 0,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 13. Customers Directory
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      sender_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 14. Persistent Conversations & Messages
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      customer_id INTEGER DEFAULT 0,
      channel TEXT NOT NULL DEFAULT 'instagram',
      external_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL DEFAULT 'user',
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 15. Normalized Order Items
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      store_id INTEGER NOT NULL DEFAULT 1,
      product_id INTEGER DEFAULT 0,
      variant_id INTEGER DEFAULT 0,
      product_name TEXT NOT NULL,
      sku TEXT DEFAULT '',
      size TEXT DEFAULT '',
      unit_price REAL NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      total_price REAL NOT NULL DEFAULT 0
    );
  `);
    // 16. Audit Logs
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT 0,
      store_id INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT DEFAULT '',
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // 17. API Keys (Merchant API Access)
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      permissions TEXT DEFAULT 'read_write',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT DEFAULT NULL,
      expires_at TEXT DEFAULT NULL,
      revoked_at TEXT DEFAULT NULL
    );
  `);
    // 18. AI Usage & Token Tracking
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      conversation_id INTEGER DEFAULT 0,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      latency INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
    // Default Store & Admin User Records Ensure (store_id = 1)
    exports.db.exec(`
    INSERT OR IGNORE INTO stores (id, owner_id, name, slug, status)
    VALUES (1, 1, 'BARON''S SILLAGE', 'default', 'active');
  `);
    // A privileged account is created only when explicitly requested through
    // environment variables. Never ship or recreate a known default account.
    if (env_1.env.bootstrapMasterAdmin) {
        const adminPassHash = hashPassword(env_1.env.masterAdminPassword);
        exports.db.prepare(`
      INSERT OR IGNORE INTO users (id, full_name, email, password_hash, status)
      VALUES (1, ?, ?, ?, 'active')
    `).run(env_1.env.masterAdminName, env_1.env.masterAdminEmail, adminPassHash);
        exports.db.prepare(`
      INSERT OR IGNORE INTO memberships (id, user_id, store_id, role, status)
      VALUES (1, 1, 1, 'OWNER', 'active')
    `).run();
    }
    runSchemaMigrations();
    // Application history must not duplicate identity/contact data or retain any
    // password hash. The user account remains the sole authentication record.
    const applicationColumns = exports.db.prepare("PRAGMA table_info(merchant_applications)").all();
    const hasLegacyApplicationData = applicationColumns.some((column) => ['tc_no', 'phone', 'password'].includes(column.name));
    if (hasLegacyApplicationData) {
        const migrateApplications = exports.db.transaction(() => {
            exports.db.exec(`
        CREATE TABLE merchant_applications_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          store_name TEXT NOT NULL,
          plan TEXT NOT NULL DEFAULT 'Pro Store',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO merchant_applications_new (id, full_name, email, store_name, plan, status, created_at, updated_at)
        SELECT id, full_name, email, store_name, plan, status, created_at, updated_at
        FROM merchant_applications;
        DROP TABLE merchant_applications;
        ALTER TABLE merchant_applications_new RENAME TO merchant_applications;
      `);
        });
        migrateApplications();
    }
    // Auto-generate webhook_verify_token for any store missing a token
    try {
        const storesWithoutToken = exports.db.prepare("SELECT id, slug FROM stores WHERE webhook_verify_token IS NULL OR webhook_verify_token = ''").all();
        for (const st of storesWithoutToken) {
            const newToken = `whsec_${st.slug}_` + crypto_1.default.randomBytes(12).toString('hex');
            exports.db.prepare('UPDATE stores SET webhook_verify_token = ? WHERE id = ?').run(newToken, st.id);
        }
    }
    catch (e) { }
    // Multi-Tenant Migration 1: products tablosunu UNIQUE(store_id, product_code) yapısına geçir
    const productsSchema = exports.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'").get();
    if (productsSchema && (productsSchema.sql.includes('product_code TEXT UNIQUE') || !productsSchema.sql.includes('UNIQUE(store_id, product_code)'))) {
        console.log('[Database Migration] 🔄 products tablosu UNIQUE(store_id, product_code) yapısına aktarılıyor...');
        const migrateProducts = exports.db.transaction(() => {
            exports.db.exec(`
        CREATE TABLE products_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          short_code TEXT NOT NULL,
          product_code TEXT NOT NULL,
          name TEXT NOT NULL,
          color TEXT DEFAULT '',
          size TEXT NOT NULL,
          price REAL NOT NULL DEFAULT 299.00,
          stock INTEGER NOT NULL DEFAULT 0,
          category TEXT DEFAULT '',
          wp_link TEXT DEFAULT '',
          media_link TEXT DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          store_name TEXT DEFAULT '',
          store_id INTEGER NOT NULL DEFAULT 1,
          UNIQUE(store_id, product_code),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
      `);
            exports.db.exec(`
        INSERT INTO products_new (id, short_code, product_code, name, color, size, price, stock, category, wp_link, media_link, created_at, updated_at, store_name, store_id)
        SELECT id, short_code, product_code, name, color, size, COALESCE(price, 299.00), stock, category, wp_link, media_link, created_at, updated_at, COALESCE(store_name, ''), COALESCE(store_id, 1)
        FROM products;
      `);
            exports.db.exec(`DROP TABLE products;`);
            exports.db.exec(`ALTER TABLE products_new RENAME TO products;`);
        });
        migrateProducts();
        console.log('[Database Migration] ✅ products tablosu başarıyla dönüştürüldü.');
    }
    // Multi-Tenant Migration 2: settings tablosunu PRIMARY KEY(store_id, key) yapısına aktar
    const settingsSchema = exports.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
    if (settingsSchema && !settingsSchema.sql.includes('store_id')) {
        console.log('[Database Migration] 🔄 settings tablosu PRIMARY KEY(store_id, key) yapısına aktarılıyor...');
        const migrateSettings = exports.db.transaction(() => {
            exports.db.exec(`
        CREATE TABLE settings_new (
          store_id INTEGER NOT NULL DEFAULT 1,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (store_id, key),
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        );
      `);
            exports.db.exec(`
        INSERT OR IGNORE INTO settings_new (store_id, key, value)
        SELECT 1, key, value FROM settings;
      `);
            exports.db.exec(`DROP TABLE settings;`);
            exports.db.exec(`ALTER TABLE settings_new RENAME TO settings;`);
        });
        migrateSettings();
        console.log('[Database Migration] ✅ settings tablosu başarıyla dönüştürüldü.');
    }
    // Multi-Tenant Migration 3: inventory tablosunu eksik ürünler için otomatik backfill et (Store & Product Code Scoped)
    try {
        const backfillInventory = exports.db.transaction(() => {
            exports.db.exec(`
        INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at)
        SELECT p.store_id, p.product_code, p.stock, 0, CURRENT_TIMESTAMP
        FROM products p
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory i 
          WHERE i.store_id = p.store_id AND UPPER(i.product_code) = UPPER(p.product_code)
        );
      `);
        });
        backfillInventory();
        console.log('[Database Migration] ✅ inventory tablosu eksik ürünler için otomatik senkronize (backfill) edildi.');
    }
    catch (e) {
        console.error('[Database Migration] ⚠️ inventory backfill uyarısı:', e.message);
    }
    // Multi-Tenant Performans İndeksleri
    exports.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_code ON products(product_code);
    CREATE INDEX IF NOT EXISTS idx_products_short ON products(short_code);
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_name);
    CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_products_store_code ON products(store_id, product_code);
    CREATE INDEX IF NOT EXISTS idx_products_store_short ON products(store_id, short_code);
    CREATE INDEX IF NOT EXISTS idx_orders_id ON orders(order_id);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_orders_sender ON orders(sender_id);
    CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_name);
    CREATE INDEX IF NOT EXISTS idx_orders_store_id ON orders(store_id);
    CREATE INDEX IF NOT EXISTS idx_orders_store_created ON orders(store_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_store_sender ON orders(store_id, sender_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_active ON campaigns(active);
    CREATE INDEX IF NOT EXISTS idx_campaigns_store_id ON campaigns(store_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_sender ON user_rewards(sender_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_store_id ON user_rewards(store_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON webhook_events(event_id);
    CREATE INDEX IF NOT EXISTS idx_stores_slug ON stores(slug);
    CREATE INDEX IF NOT EXISTS idx_inventory_store ON inventory(store_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_store_code ON inventory(store_id, product_code);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_store_code_unique ON inventory(store_id, product_code);
    CREATE INDEX IF NOT EXISTS idx_customers_store_sender ON customers(store_id, sender_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_store_customer ON conversations(store_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_store ON ai_usage(store_id);
  `);
    // Varsayılan Başlangıç Stok & Kampanya Verilerini Yükle
    seedInitialProducts();
    seedInitialSettings();
    seedInitialCampaigns();
}
/**
 * Başlangıç Stok Verilerini Ekler
 */
function seedInitialProducts() {
    const countStmt = exports.db.prepare('SELECT COUNT(*) as count FROM products');
    const result = countStmt.get();
    if (result.count === 0) {
        console.log('[Database] 🚀 Ürünler tablosu boş, başlangıç stok ve fiyat verileri yükleniyor...');
        const insertStmt = exports.db.prepare(`
      INSERT OR IGNORE INTO products (short_code, product_code, name, color, size, price, stock, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const initialProducts = [
            { shortCode: 'KGMLW', productCode: 'KGMLW-S', name: 'KUMAŞ GÖMLEK', color: 'BEYAZ', size: 'S', price: 299.00, stock: 99, category: 'GÖMLEK' },
            { shortCode: 'KGMLW', productCode: 'KGMLW-M', name: 'KUMAŞ GÖMLEK', color: 'BEYAZ', size: 'M', price: 299.00, stock: 5, category: 'GÖMLEK' },
            { shortCode: 'KGMLW', productCode: 'KGMLW-L', name: 'KUMAŞ GÖMLEK', color: 'BEYAZ', size: 'L', price: 299.00, stock: 100, category: 'GÖMLEK' },
            { shortCode: 'KTGMLB', productCode: 'KTGMLB-S', name: 'SİYAH KETEN GÖMLEK', color: 'SİYAH', size: 'S', price: 349.00, stock: 100, category: 'KETEN GÖMLEK' },
            { shortCode: 'KTGMLB', productCode: 'KTGMLB-M', name: 'SİYAH KETEN GÖMLEK', color: 'SİYAH', size: 'M', price: 349.00, stock: 100, category: 'KETEN GÖMLEK' },
            { shortCode: 'KTGMLB', productCode: 'KTGMLB-L', name: 'SİYAH KETEN GÖMLEK', color: 'SİYAH', size: 'L', price: 349.00, stock: 100, category: 'KETEN GÖMLEK' },
            { shortCode: 'DGMLP', productCode: 'DGMLP-S', name: 'DESENLİ GÖMLEK', color: 'PEMBE', size: 'S', price: 399.00, stock: 100, category: 'DESENLİ GÖMLEK' },
            { shortCode: 'DGMLP', productCode: 'DGMLP-M', name: 'DESENLİ GÖMLEK', color: 'PEMBE', size: 'M', price: 399.00, stock: 100, category: 'DESENLİ GÖMLEK' },
            { shortCode: 'NDL41', productCode: 'NDL41-41', name: 'NIKE DUNK LOW', color: 'BEYAZ/SİYAH', size: '41', price: 1299.00, stock: 50, category: 'AYAKKABI' },
            { shortCode: 'STRC39', productCode: 'STRC39-39', name: 'STAR CROSS', color: 'BEYAZ', size: '39', price: 899.00, stock: 30, category: 'AYAKKABI' },
            { shortCode: 'TSW', productCode: 'TSW-S', name: 'TSW T-SHIRT', color: 'BEYAZ', size: 'S', price: 199.00, stock: 75, category: 'T-SHIRT' }
        ];
        for (const p of initialProducts) {
            insertStmt.run(p.shortCode, p.productCode, p.name, p.color, p.size, p.price, p.stock, p.category);
        }
        console.log(`[Database] ✅ ${initialProducts.length} varsayılan ürün fiyatları ile yüklendi.`);
    }
}
/**
 * Varsayılan Sistem Ayarlarını Yükler (Kargo Ücretleri)
 */
function seedInitialSettings() {
    const setStmt = exports.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    setStmt.run('shipping_fee', '49'); // Standard Kargo 49 TL
    setStmt.run('free_shipping_threshold', '1500'); // 1500 TL Üzeri Ücretsiz Kargo
}
/**
 * Varsayılan Kampanyaları Yükler
 */
function seedInitialCampaigns() {
    const countStmt = exports.db.prepare('SELECT COUNT(*) as count FROM campaigns');
    const result = countStmt.get();
    if (result.count === 0) {
        const insertStmt = exports.db.prepare(`
      INSERT INTO campaigns (title, description, code, discount_percent, discount_amount, min_order_amount, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        insertStmt.run('🚀 1500 TL Üzeri Ücretsiz Kargo!', '1500 TL ve üzeri siparişlerde kargo ücreti BARON\'S SILLAGE tarafından karşılanır.', 'KARGO_BEDAVA', 0, 49, 1500, 1);
        insertStmt.run('🎉 BARONS10 İndirim Kodu', 'Tüm siparişlerde %10 Hoşgeldin İndirimi.', 'BARONS10', 10, 0, 0, 1);
        console.log('[Database] ✅ Aktif başlangıç kampanyaları yüklendi.');
    }
}
function createMerchantApplication(data) {
    const stmt = exports.db.prepare(`
    INSERT INTO merchant_applications (full_name, email, store_name, plan, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
    return stmt.run(data.fullName, data.email, data.storeName, data.plan || 'Pro Store (₺6.000 / Ay)');
}
function getAllMerchantApplications() {
    const stmt = exports.db.prepare(`SELECT * FROM merchant_applications ORDER BY id DESC`);
    return stmt.all();
}
function approveMerchantApplication(identifier) {
    const idStr = String(identifier).trim();
    const idNum = parseInt(idStr, 10) || 0;
    const stmt = exports.db.prepare(`
    UPDATE merchant_applications 
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP 
    WHERE id = ? OR LOWER(email) = LOWER(?) OR LOWER(store_name) = LOWER(?)
  `);
    return stmt.run(idNum, idStr, idStr);
}
function rejectMerchantApplication(identifier) {
    const idStr = String(identifier).trim();
    const idNum = parseInt(idStr, 10) || 0;
    const stmt = exports.db.prepare(`
    UPDATE merchant_applications 
    SET status = 'rejected', updated_at = CURRENT_TIMESTAMP 
    WHERE id = ? OR LOWER(email) = LOWER(?) OR LOWER(store_name) = LOWER(?)
  `);
    return stmt.run(idNum, idStr, idStr);
}
function findMerchantApplicationByIdentifier(identifier) {
    const cleanId = (identifier || '').trim();
    const stmt = exports.db.prepare(`
    SELECT * FROM merchant_applications 
    WHERE LOWER(email) = LOWER(?) 
       OR LOWER(store_name) = LOWER(?) 
       OR LOWER(full_name) = LOWER(?)
  `);
    return stmt.get(cleanId, cleanId, cleanId);
}
/**
 * Şifre Güvenliği & Hashleme (PBKDF2 / SHA-512)
 */
function hashPassword(password) {
    if (!password) {
        throw new Error('Password must not be empty.');
    }
    const salt = crypto_1.default.randomBytes(16);
    const hash = crypto_1.default.pbkdf2Sync(password, salt, 210_000, 64, 'sha512');
    return `pbkdf2:sha512:v1:210000:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}
function verifyPassword(password, storedHash) {
    if (!password || !storedHash)
        return false;
    const parts = storedHash.split(':');
    try {
        if (parts.length === 6 &&
            parts[0] === 'pbkdf2' &&
            parts[1] === 'sha512' &&
            parts[2] === 'v1' &&
            Number(parts[3]) === 210_000) {
            const salt = Buffer.from(parts[4], 'base64url');
            const expectedHash = Buffer.from(parts[5], 'base64url');
            if (salt.length !== 16 || expectedHash.length !== 64)
                return false;
            const computedHash = crypto_1.default.pbkdf2Sync(password, salt, 210_000, 64, 'sha512');
            return crypto_1.default.timingSafeEqual(computedHash, expectedHash);
        }
        // Existing PBKDF2 hashes are supported only so that they can be upgraded
        // at the next successful login. Plain-text values are never accepted.
        if (parts.length === 3 && parts[0] === 'pbkdf2' && parts[1] === 'sha512') {
            const expectedHash = Buffer.from(parts[2], 'hex');
            if (expectedHash.length !== 64)
                return false;
            const computedHash = crypto_1.default.pbkdf2Sync(password, 'iscworks_salt_2026', 1_000, 64, 'sha512');
            return crypto_1.default.timingSafeEqual(computedHash, expectedHash);
        }
    }
    catch {
        return false;
    }
    return false;
}
/** True when a valid legacy PBKDF2 record should be replaced at login. */
function needsPasswordRehash(storedHash) {
    const parts = (storedHash || '').split(':');
    return parts.length !== 6 ||
        parts[0] !== 'pbkdf2' ||
        parts[1] !== 'sha512' ||
        parts[2] !== 'v1' ||
        Number(parts[3]) !== 210_000;
}
