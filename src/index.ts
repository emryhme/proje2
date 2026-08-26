import express from 'express';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import { env } from './config/env';
import { WebhookController } from './controllers/webhook.controller';
import { OrderService } from './services/order.service';
import { StockService } from './services/stock.service';
import { AIService } from './services/ai.service';
import { GeminiService } from './services/gemini.service';
import { AdminCopilotService } from './services/admin-copilot.service';
import { FacebookService } from './services/facebook.service';
import { DemoAIService } from './services/demo-ai.service';
import { extractProductCode } from './utils/regex.util';
import { db, hashPassword, initDatabase, needsPasswordRehash, performDataMaintenance, verifyPassword } from './database/db';
import { AuthMiddleware, AuthenticatedRequest } from './middleware/auth.middleware';
import { createRateLimiter, csrfProtection, sanitizeServerErrors, securityHeaders } from './middleware/security.middleware';
import { decryptSettingSecret, encryptSettingSecret } from './utils/secret.util';
import { AIProviderService } from './services/ai-provider.service';
import { HumanHandoffService } from './services/human-handoff.service';

// Initialize schema, migrations, and seed data once before serving requests.
initDatabase();
performDataMaintenance(env.dataRetentionDays, env.pendingRegistrationRetentionDays);
const maintenanceTimer = setInterval(() => performDataMaintenance(env.dataRetentionDays, env.pendingRegistrationRetentionDays), 24 * 60 * 60_000);
maintenanceTimer.unref();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(sanitizeServerErrors);

// Apply Global CORS Middleware
app.use(AuthMiddleware.cors);

// Capture the exact bytes Meta signed before JSON parsing changes their form.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    (req as any).rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(csrfProtection);

app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ status: 'ok', database: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
  } catch {
    return res.status(503).json({ status: 'unhealthy', database: 'unavailable' });
  }
});

const apiLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 600, message: 'Çok fazla API isteği gönderildi. Lütfen kısa süre sonra tekrar deneyin.' });
app.use('/api', apiLimiter);
const masterPanelLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 180, message: 'Çok fazla panel isteği gönderildi. Lütfen daha sonra tekrar deneyin.' });

const demoAiRequests = new Map<string, number[]>();
let demoAiGlobalRequests: number[] = [];
app.post('/api/demo/ai', async (req, res) => {
  const forwardedIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const clientKey = forwardedIp || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  demoAiGlobalRequests = demoAiGlobalRequests.filter(timestamp => now - timestamp < 60_000);
  if (demoAiGlobalRequests.length >= 120) {
    return res.status(429).json({ success: false, error: 'Demo yapay zeka şu anda yoğun. Lütfen bir dakika sonra yeniden deneyin.' });
  }
  const recentRequests = (demoAiRequests.get(clientKey) || []).filter(timestamp => now - timestamp < 60_000);
  if (recentRequests.length >= 12) {
    return res.status(429).json({ success: false, error: 'Demo mesaj limiti doldu. Lütfen bir dakika sonra yeniden deneyin.' });
  }
  recentRequests.push(now);
  demoAiGlobalRequests.push(now);
  demoAiRequests.set(clientKey, recentRequests);
  if (demoAiRequests.size > 5_000) {
    for (const [key, timestamps] of demoAiRequests) {
      if (!timestamps.some(timestamp => now - timestamp < 60_000)) demoAiRequests.delete(key);
    }
  }

  try {
    const message = String(req.body?.message || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message || message.length > 800) {
      return res.status(400).json({ success: false, error: 'Mesaj 1-800 karakter arasında olmalıdır.' });
    }
    const reply = await DemoAIService.reply(message, history);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, reply, demo: true });
  } catch (error: any) {
    console.error('[Demo AI] Gemini request failed:', error?.response?.data || error?.message || error);
    return res.status(502).json({ success: false, error: 'Demo yapay zekası şu anda yanıt veremiyor. Lütfen tekrar deneyin.' });
  }
});

import authRouter from './routes/auth.routes';
app.use(authRouter);
import integrationRouter from './routes/integration.routes';
app.use(integrationRouter);

// Keep legacy HTML links working while presenting canonical, extension-free URLs.
// Index documents map to a meaningful landing route instead of exposing index.html.
app.get(/\.html$/, (req, res, next) => {
  const pathname = req.path;
  let cleanPath = pathname.slice(0, -'.html'.length);
  if (cleanPath === '/index') cleanPath = '/';
  if (cleanPath === '/admin/index') cleanPath = '/admin/dashboard';
  if (cleanPath.endsWith('/index')) cleanPath = cleanPath.slice(0, -'/index'.length) || '/';
  if (cleanPath === pathname) return next();
  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  return res.redirect(301, `${cleanPath}${query}`);
});

// Static Admin UI Server (Merchant Panel)
const adminDirectory = path.resolve(__dirname, '../public/admin');
app.get(['/admin', '/admin/'], (_req, res) => res.redirect(302, '/admin/dashboard'));
app.get('/admin/dashboard', (_req, res) => res.sendFile(path.join(adminDirectory, 'index.html')));
app.use('/admin', express.static(adminDirectory, { extensions: ['html'], redirect: false, dotfiles: 'deny' }));

// Static Master Admin UI Server (Platform Owner Panel).
// Its public path exists only in the server environment and is never embedded in public pages.
const masterAdminBasePath = `/${env.masterAdminPanelPath}`;
const masterAdminDirectory = path.resolve(__dirname, '../public/master-admin');
const hideMasterPanelFromIndexes = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

// The former well-known path must look exactly like any other missing page.
if (masterAdminBasePath !== '/master-admin') {
  app.use('/master-admin', (_req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.status(404).sendFile(path.resolve(__dirname, '../public/404.html'));
  });
}

app.get([masterAdminBasePath, `${masterAdminBasePath}/`], masterPanelLimiter, hideMasterPanelFromIndexes, (_req, res) => res.redirect(302, `${masterAdminBasePath}/dashboard`));
app.get(`${masterAdminBasePath}/dashboard`, masterPanelLimiter, hideMasterPanelFromIndexes, (_req, res) => res.sendFile(path.join(masterAdminDirectory, 'index.html')));
app.use(masterAdminBasePath, masterPanelLimiter, hideMasterPanelFromIndexes, express.static(masterAdminDirectory, { extensions: ['html'], index: false, redirect: false, dotfiles: 'deny' }));

// ==========================================
import masterAdminRouter from './routes/master-admin.routes';
import planRouter from './routes/plan.routes';
import dataImportRouter from './routes/data-import.routes';
app.use(masterAdminRouter);
app.use(planRouter);
app.use(dataImportRouter);
app.use('/', express.static(path.resolve(__dirname, '../public'), { extensions: ['html'], dotfiles: 'deny' }));
// --- PRODUCTS & STOCKS ---
app.get('/api/stocks', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  const storeId = req.auth!.storeId;
  const stocks = await StockService.getAllProducts(storeId);
  res.json({ success: true, stocks });
});

app.get('/api/stock/:code', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  const storeId = req.auth!.storeId;
  const result = await StockService.checkStock(storeId, String(req.params.code));
  res.json(result);
});

app.post('/api/products', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { shortCode, productCode, name, color, size, stock, price, category, storeName, instagramMediaId } = req.body || {};
    if (!shortCode || !name || !size) {
      return res.status(400).json({ success: false, error: 'Kısa kod, ürün ismi ve beden/numara alanları zorunludur.' });
    }

    const result = await StockService.addProduct({
      storeId,
      shortCode,
      productCode,
      name,
      color: color || 'Standart',
      size,
      stock: stock ? Number(stock) : 0,
      price: price ? Number(price) : 299,
      category: category || 'Genel',
      storeName: storeName || '',
      instagramMediaId: String(instagramMediaId || '').trim().slice(0, 128)
    });

    if (result.success) {
      FacebookService.reconcileCachedInstagramMedia(storeId);
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'ADD_PRODUCT', 'products', result.productCode || '');
      res.json({
        success: true,
        message: 'Ürün mağaza stok veritabanınıza başarıyla eklendi!',
        productCode: result.productCode
      });
    } else {
      res.status(500).json({ success: false, error: 'Ürün veritabanına kaydedilemedi.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

app.post('/api/products/price', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { productCode, price } = req.body;
    if (!productCode || price === undefined) {
      return res.status(400).json({ success: false, error: 'productCode ve price zorunludur.' });
    }

    const numPrice = Number(price);
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({ success: false, error: 'Geçersiz fiyat.' });
    }

    const stmt = db.prepare('UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND (product_code = ? OR short_code = ?)');
    const result = stmt.run(numPrice, storeId, productCode, productCode);

    if (result.changes > 0) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'UPDATE_PRICE', 'products', productCode, '', String(numPrice));
      res.json({ success: true, message: `Ürün (${productCode}) fiyatı ${numPrice} TL olarak güncellendi.` });
    } else {
      res.status(404).json({ success: false, error: 'Ürün bu mağazada bulunamadı.' });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/products/bulk-update', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Güncellenecek veri listesi boş veya geçersiz.' });
    }

    const updatePriceStmt = db.prepare('UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_code = ?');
    const updateStockStmt = db.prepare('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_code = ?');

    let updatedCount = 0;
    const bulkTransaction = db.transaction((items: any[]) => {
      for (const item of items) {
        if (item.productCode) {
          const cleanCode = String(item.productCode).trim().toUpperCase();
          if (item.price !== undefined && !isNaN(Number(item.price)) && Number(item.price) >= 0) {
            const resPrice = updatePriceStmt.run(Number(item.price), storeId, cleanCode);
            if (resPrice.changes > 0) updatedCount++;
          }
          if (item.stock !== undefined && !isNaN(Number(item.stock)) && Number(item.stock) >= 0) {
            const stockNum = Number(item.stock);
            const resStock = updateStockStmt.run(stockNum, storeId, cleanCode);
            if (resStock.changes > 0) {
              updatedCount++;
              try {
                let inv = db.prepare('SELECT id FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, cleanCode) as any;
                if (inv) {
                  db.prepare('UPDATE inventory SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stockNum, inv.id);
                } else {
                  db.prepare('INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)').run(storeId, cleanCode, stockNum);
                }
              } catch (e) {}
            }
          }
        }
      }
    });

    bulkTransaction(updates);
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'BULK_UPDATE_PRODUCTS', 'products', `${updates.length} items`);

    if (updatedCount === 0) {
      return res.status(404).json({ success: false, error: 'Belirtilen ürünler bu mağazada bulunamadı veya güncelleme yapılamadı.' });
    }

    return res.json({ success: true, message: `${updatedCount} adet güncelleme başarıyla kaydedildi!`, updatedCount });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/products/delete', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { productCode } = req.body;
    if (!productCode) {
      return res.status(400).json({ success: false, error: 'productCode parametresi gereklidir' });
    }

    const success = await StockService.deleteProduct(storeId, productCode);
    if (success) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'DELETE_PRODUCT', 'products', productCode);
      return res.json({ success: true, message: `Ürün (${productCode}) silindi.` });
    } else {
      return res.status(404).json({ success: false, error: 'Ürün bu mağazada bulunamadı veya silinemedi.' });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

app.post('/api/products/update-stock', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { productCode, newStock } = req.body;
    if (!productCode || newStock === undefined || newStock === null) {
      return res.status(400).json({ success: false, error: 'productCode ve newStock parametreleri gereklidir' });
    }

    const numStock = Number(newStock);
    if (isNaN(numStock) || numStock < 0) {
      return res.status(400).json({ success: false, error: 'Geçersiz stok miktarı. Stok 0 veya pozitif bir sayı olmalıdır.' });
    }

    const success = await StockService.updateStock(storeId, String(productCode), numStock);
    if (success) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'UPDATE_STOCK', 'products', String(productCode), '', String(numStock));
      return res.json({ success: true, message: `Ürün (${productCode}) stoğu ${numStock} olarak güncellendi.`, productCode, stock: numStock });
    } else {
      return res.status(404).json({ success: false, error: 'Ürün bu mağazada bulunamadı veya stok güncellenemedi.' });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

// --- ORDERS ---
app.get('/api/orders', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  const storeId = req.auth!.storeId;
  const orders = await OrderService.getOrders(storeId);
  res.json({ success: true, count: orders.length, orders });
});

app.post('/api/orders/status', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { orderId, status, reason } = req.body;
    if (!orderId || !status || (status !== 'OK' && status !== 'DEC')) {
      return res.status(400).json({ success: false, error: 'orderId ve geçerli bir status (OK veya DEC) gereklidir' });
    }

    const success = await OrderService.updateOrderStatus(storeId, orderId, status, reason);
    if (success) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'UPDATE_ORDER_STATUS', 'orders', orderId, '', status);
      res.json({
        success: true,
        message: `Sipariş ${orderId} durumu '${status}' olarak güncellendi.`,
        orderId,
        status
      });
    } else {
      res.status(500).json({ success: false, error: 'Sipariş durumu güncellenemedi.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

app.post('/api/orders/delete', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId parametresi gereklidir' });
    }

    const success = await OrderService.deleteOrder(storeId, orderId);
    if (success) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'DELETE_ORDER', 'orders', orderId);
      res.json({ success: true, message: `Sipariş (${orderId}) silindi.` });
    } else {
      res.status(500).json({ success: false, error: 'Sipariş silinemedi.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

// --- CAMPAIGNS ---
app.get('/api/campaigns', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const campaigns = db.prepare('SELECT * FROM campaigns WHERE store_id = ? ORDER BY id DESC').all(storeId);
    return res.json({ success: true, campaigns });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Kampanyalar alınırken sunucu hatası oluştu.' });
  }
});

app.post('/api/campaigns', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { title, description, code, discountPercent, discountAmount, minOrderAmount, startDate, endDate } = req.body || {};

    if (!title || !String(title).trim() || !description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: 'Kampanya başlığı ve açıklaması zorunludur.' });
    }

    const cleanTitle = String(title).trim();
    const cleanDesc = String(description).trim();
    const cleanCode = code ? String(code).trim().toUpperCase() : '';
    const numPercent = discountPercent !== undefined ? Number(discountPercent) : 0;
    const numAmount = discountAmount !== undefined ? Number(discountAmount) : 0;
    const numMinOrder = minOrderAmount !== undefined ? Number(minOrderAmount) : 0;

    if (!Number.isFinite(numPercent) || numPercent < 0 || numPercent > 100) {
      return res.status(400).json({ success: false, error: 'Geçersiz indirim yüzdesi.' });
    }
    if (!Number.isFinite(numAmount) || numAmount < 0 || !Number.isFinite(numMinOrder) || numMinOrder < 0) {
      return res.status(400).json({ success: false, error: 'İndirim ve minimum sipariş tutarı geçerli olmalıdır.' });
    }
    if (numPercent === 0 && numAmount === 0) {
      return res.status(400).json({ success: false, error: 'En az bir indirim yüzdesi veya sabit indirim tutarı girin.' });
    }
    const cleanStartDate = startDate ? String(startDate).trim() : null;
    const cleanEndDate = endDate ? String(endDate).trim() : null;
    if ((cleanStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanStartDate)) || (cleanEndDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanEndDate))) {
      return res.status(400).json({ success: false, error: 'Kampanya tarihleri geçerli olmalıdır.' });
    }
    if (cleanStartDate && cleanEndDate && cleanStartDate > cleanEndDate) {
      return res.status(400).json({ success: false, error: 'Kampanya bitiş tarihi başlangıç tarihinden önce olamaz.' });
    }

    const stmt = db.prepare(`
      INSERT INTO campaigns (store_id, title, description, code, discount_percent, discount_amount, min_order_amount, start_date, end_date, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const result = stmt.run(
      storeId,
      cleanTitle, 
      cleanDesc, 
      cleanCode, 
      numPercent, 
      numAmount, 
      numMinOrder,
      cleanStartDate,
      cleanEndDate
    );

    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'CREATE_CAMPAIGN', 'campaigns', cleanCode || cleanTitle);
    return res.status(201).json({
      success: true,
      message: 'Kampanya başarıyla oluşturuldu.',
      id: Number(result.lastInsertRowid),
      campaign: {
        id: Number(result.lastInsertRowid),
        store_id: storeId,
        title: cleanTitle,
        description: cleanDesc,
        code: cleanCode,
        discount_percent: numPercent,
        active: 1
      }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Kampanya oluşturulurken veritabanı hatası oluştu.' });
  }
});

app.post('/api/campaigns/toggle', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { id, active } = req.body || {};

    if (!id) {
      return res.status(400).json({ success: false, error: 'Kampanya id zorunludur.' });
    }

    const newActive = active ? 1 : 0;
    const result = db.prepare('UPDATE campaigns SET active = ? WHERE store_id = ? AND id = ?').run(newActive, storeId, String(id));

    if (result.changes > 0) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'TOGGLE_CAMPAIGN', 'campaigns', String(id), '', String(newActive));
      return res.json({ success: true, message: 'Kampanya durumu güncellendi.', active: newActive });
    } else {
      return res.status(404).json({ success: false, error: 'Kampanya bulunamadı veya bu mağazaya ait değil.' });
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Kampanya güncellenemedi.' });
  }
});

app.delete('/api/campaigns/:id', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const campaignId = String(req.params.id);
    const result = db.prepare('DELETE FROM campaigns WHERE store_id = ? AND id = ?').run(storeId, campaignId);

    if (result.changes > 0) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'DELETE_CAMPAIGN', 'campaigns', campaignId);
      return res.json({ success: true, message: 'Kampanya silindi.' });
    } else {
      return res.status(404).json({ success: false, error: 'Kampanya bulunamadı veya bu mağazaya ait değil.' });
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Kampanya silinirken hata oluştu.' });
  }
});

// --- SETTINGS ---
const PUBLIC_SETTING_KEYS = new Set([
  'shipping_fee', 'free_shipping_threshold', 'loyalty_threshold', 'auto_vip_reward_enabled',
  'bot_name', 'bot_tone', 'bot_system_prompt', 'ai_provider',
  'human_handoff_enabled', 'human_handoff_minutes'
]);

app.get('/api/settings', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const placeholders = [...PUBLIC_SETTING_KEYS].map(() => '?').join(',');
    const rows = db.prepare(`SELECT key, value FROM settings WHERE store_id = ? AND key IN (${placeholders})`).all(storeId, ...PUBLIC_SETTING_KEYS) as any[];
    const settingsObj: Record<string, string> = {};
    for (const r of rows) {
      if (r && r.key) {
        settingsObj[r.key] = r.value || '';
      }
    }
    settingsObj.ai_provider = settingsObj.ai_provider === 'gemini' ? 'gemini' : 'openai';
    settingsObj.human_handoff_enabled = settingsObj.human_handoff_enabled === '0' ? '0' : '1';
    settingsObj.human_handoff_minutes = ['15', '30', '60', '120'].includes(settingsObj.human_handoff_minutes) ? settingsObj.human_handoff_minutes : '60';
    const secretRows = db.prepare("SELECT key, value FROM settings WHERE store_id = ? AND key IN ('ai_api_key', 'openai_api_key', 'gemini_api_key', 'telegram_bot_token', 'telegram_chat_id')").all(storeId) as Array<{ key: string; value: string }>;
    const secrets = Object.fromEntries(secretRows.map(row => [row.key, decryptSettingSecret(String(row.value || '')).trim()]));
    const legacyProvider = settingsObj.ai_provider === 'gemini' ? 'gemini' : 'openai';
    settingsObj.openai_api_key_configured = secrets.openai_api_key || (legacyProvider === 'openai' && secrets.ai_api_key) ? '1' : '0';
    settingsObj.gemini_api_key_configured = secrets.gemini_api_key || (legacyProvider === 'gemini' && secrets.ai_api_key) ? '1' : '0';
    settingsObj.ai_api_key_configured = settingsObj[`${settingsObj.ai_provider}_api_key_configured`];
    settingsObj.telegram_configured = secrets.telegram_bot_token && secrets.telegram_chat_id ? '1' : '0';
    res.json({ success: true, settings: settingsObj, settingsList: rows });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message, settings: {} });
  }
});

app.post('/api/settings', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { key, value, settings, shippingFee, freeShippingThreshold, aiApiKey, clearAiApiKey, telegramBotToken, telegramChatId, clearTelegram } = req.body || {};

    const normalizeSetting = (rawKey: unknown, rawValue: unknown): { key: string; value: string } | null => {
      const settingKey = String(rawKey || '');
      if (!PUBLIC_SETTING_KEYS.has(settingKey)) return null;
      let settingValue = String(rawValue ?? '');
      if (settingKey === 'bot_name') {
        settingValue = settingValue.trim().slice(0, 40);
        if (!settingValue) throw new Error('Yapay zeka asistan adı boş bırakılamaz.');
      } else if (settingKey === 'bot_tone') {
        if (!['luxury', 'friendly', 'formal', 'patron'].includes(settingValue)) throw new Error('Geçersiz yapay zeka kişilik üslubu.');
      } else if (settingKey === 'bot_system_prompt') {
        settingValue = settingValue.trim().slice(0, 4000);
      } else if (settingKey === 'ai_provider') {
        if (!['openai', 'gemini'].includes(settingValue)) throw new Error('Geçersiz yapay zeka sağlayıcısı.');
      } else if (settingKey === 'auto_vip_reward_enabled') {
        if (!['0', '1', 'false', 'true'].includes(settingValue.toLowerCase())) throw new Error('Geçersiz otomatik VIP ayarı.');
        settingValue = ['1', 'true'].includes(settingValue.toLowerCase()) ? '1' : '0';
      } else if (settingKey === 'human_handoff_enabled') {
        if (!['0', '1', 'false', 'true'].includes(settingValue.toLowerCase())) throw new Error('Geçersiz human handoff ayarı.');
        settingValue = ['1', 'true'].includes(settingValue.toLowerCase()) ? '1' : '0';
      } else if (settingKey === 'human_handoff_minutes') {
        if (!['15', '30', '60', '120'].includes(settingValue)) throw new Error('Geçersiz standby süresi.');
      } else {
        const numericValue = Number(settingValue);
        if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1_000_000) throw new Error('Fiyat ayarı geçerli bir pozitif sayı olmalıdır.');
        settingValue = String(numericValue);
      }
      return { key: settingKey, value: settingValue };
    };

    const updates: Array<{ key: string; value: string }> = [];
    
    if (key && value !== undefined) {
      const normalized = normalizeSetting(key, value);
      if (!normalized) return res.status(400).json({ success: false, error: 'Bu ayar panel üzerinden değiştirilemez.' });
      updates.push(normalized);
    }
    if (shippingFee !== undefined) {
      updates.push(normalizeSetting('shipping_fee', shippingFee)!);
    }
    if (freeShippingThreshold !== undefined) {
      updates.push(normalizeSetting('free_shipping_threshold', freeShippingThreshold)!);
    }
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [k, v] of Object.entries(settings)) {
        const normalized = normalizeSetting(k, v);
        if (!normalized) return res.status(400).json({ success: false, error: `${String(k)} ayarı panel üzerinden değiştirilemez.` });
        updates.push(normalized);
      }
    }

    const saveSetting = db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)');
    const cleanAiApiKey = typeof aiApiKey === 'string' ? aiApiKey.trim() : '';
    const cleanTelegramBotToken = typeof telegramBotToken === 'string' ? telegramBotToken.trim() : '';
    const cleanTelegramChatId = typeof telegramChatId === 'string' ? telegramChatId.trim() : '';
    if (Boolean(cleanTelegramBotToken) !== Boolean(cleanTelegramChatId)) {
      return res.status(400).json({ success: false, error: 'Telegram Bot Token ve Chat ID birlikte girilmelidir.' });
    }
    if (cleanTelegramBotToken && !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(cleanTelegramBotToken)) {
      return res.status(400).json({ success: false, error: 'Telegram Bot Token biçimi geçersiz.' });
    }
    if (cleanTelegramChatId && !/^-?\d{1,20}$/.test(cleanTelegramChatId)) {
      return res.status(400).json({ success: false, error: 'Telegram Chat ID biçimi geçersiz.' });
    }
    if (cleanAiApiKey && (cleanAiApiKey.length < 20 || cleanAiApiKey.length > 512)) {
      return res.status(400).json({ success: false, error: 'API anahtarı geçerli uzunlukta değil.' });
    }
    const requestedProvider = updates.find(update => update.key === 'ai_provider')?.value;
    const currentProviderRow = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'ai_provider'").get(storeId) as { value?: string } | undefined;
    const currentProvider = currentProviderRow?.value === 'gemini' ? 'gemini' : 'openai';
    const effectiveProvider = requestedProvider === 'gemini' ? 'gemini' : requestedProvider === 'openai' ? 'openai' : currentProvider;
    const looksLikeOpenAIKey = /^sk-[A-Za-z0-9_-]+$/.test(cleanAiApiKey);
    const looksLikeGeminiKey = /^(?:AIza[A-Za-z0-9_-]+|AQ\.[A-Za-z0-9._-]+)$/.test(cleanAiApiKey);
    if (cleanAiApiKey && effectiveProvider === 'openai' && looksLikeGeminiKey) {
      return res.status(400).json({ success: false, error: 'Bu anahtar Google Gemini anahtarına benziyor. OpenAI seçiliyken OpenAI API anahtarı giriniz.' });
    }
    if (cleanAiApiKey && effectiveProvider === 'gemini' && looksLikeOpenAIKey) {
      return res.status(400).json({ success: false, error: 'Bu anahtar OpenAI anahtarına benziyor. Gemini seçiliyken Google Gemini API anahtarı giriniz.' });
    }
    const providerSecretKey = `${effectiveProvider}_api_key`;
    const savedProviderSecret = db.prepare('SELECT value FROM settings WHERE store_id = ? AND key = ?').get(storeId, providerSecretKey) as { value?: string } | undefined;
    const legacySecret = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'ai_api_key'").get(storeId) as { value?: string } | undefined;
    const hasSavedProviderKey = Boolean(decryptSettingSecret(String(savedProviderSecret?.value || '')).trim())
      || (effectiveProvider === currentProvider && Boolean(decryptSettingSecret(String(legacySecret?.value || '')).trim()));
    if (requestedProvider && requestedProvider !== currentProvider && !cleanAiApiKey && !hasSavedProviderKey) {
      return res.status(400).json({ success: false, error: 'Bu sağlayıcı için önce API anahtarı kaydedilmelidir.' });
    }
    db.transaction(() => {
      updates.forEach(update => saveSetting.run(storeId, update.key, update.value));
      if (updates.some(update => update.key === 'human_handoff_enabled' && update.value === '0')) {
        db.prepare(`
          UPDATE conversations
          SET status = 'active', standby_until = NULL, standby_reason = '', standby_started_at = NULL
          WHERE store_id = ? AND status = 'standby'
        `).run(storeId);
      }
      if (cleanAiApiKey) saveSetting.run(storeId, providerSecretKey, encryptSettingSecret(cleanAiApiKey));
      if (cleanTelegramBotToken && cleanTelegramChatId) {
        saveSetting.run(storeId, 'telegram_bot_token', encryptSettingSecret(cleanTelegramBotToken));
        saveSetting.run(storeId, 'telegram_chat_id', encryptSettingSecret(cleanTelegramChatId));
      }
      if (clearTelegram === true) {
        db.prepare("DELETE FROM settings WHERE store_id = ? AND key IN ('telegram_bot_token', 'telegram_chat_id')").run(storeId);
      }
      if (clearAiApiKey === true) {
        db.prepare('DELETE FROM settings WHERE store_id = ? AND key = ?').run(storeId, providerSecretKey);
        if (effectiveProvider === currentProvider) {
          db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'ai_api_key'").run(storeId);
        }
      }
      if (legacySecret?.value && currentProvider === effectiveProvider && !savedProviderSecret?.value && !cleanAiApiKey && clearAiApiKey !== true) {
        saveSetting.run(storeId, providerSecretKey, legacySecret.value);
      }
    })();

    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'UPDATE_SETTINGS', 'settings', 'all');
    res.json({ success: true, message: 'Ayarlar güncellendi.' });
  } catch (e: any) {
    const status = /ayar|sayı|üslup|adı/i.test(String(e.message || '')) ? 400 : 500;
    res.status(status).json({ success: false, error: e.message });
  }
});

app.get('/api/human-handoff/conversations', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const config = HumanHandoffService.getStoreConfig(storeId);
    const conversations = HumanHandoffService.listActiveStandbyConversations(storeId);
    res.json({ success: true, config, conversations });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message || 'Standby görüşmeleri alınamadı.' });
  }
});

app.post('/api/human-handoff/conversations/:id/resume', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ success: false, error: 'Geçersiz görüşme kimliği.' });
    }
    if (!HumanHandoffService.resumeConversation(storeId, conversationId)) {
      return res.status(404).json({ success: false, error: 'Görüşme bulunamadı.' });
    }
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'RESUME_AI_CONVERSATION', 'conversations', String(conversationId));
    return res.json({ success: true, message: 'AI bu görüşme için yeniden devreye alındı.' });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'AI yeniden devreye alınamadı.' });
  }
});

app.get('/api/stores/webhook-info', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    let store = db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at, webhook_verify_token FROM stores WHERE id = ?').get(storeId) as any;

    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    if (!store.webhook_verify_token) {
      const newToken = `whsec_${store.slug}_` + crypto.randomBytes(12).toString('hex');
      db.prepare('UPDATE stores SET webhook_verify_token = ? WHERE id = ?').run(newToken, storeId);
      store.webhook_verify_token = newToken;
    }

    const host = req.get('host') || '136.92.8.201:3000';
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const webhookUrl = `${protocol}://${host}/api/webhook/${store.slug}`;
    const hasInstagramToken = !!db.prepare("SELECT 1 FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").get(storeId);
    const hasInstagramCommentPermission = !!db.prepare(`
      SELECT 1 FROM settings
      WHERE store_id = ?
        AND key IN ('instagram_comment_permission_granted', 'instagram_comment_access_enabled')
        AND value = '1'
    `).get(storeId);
    const commentAutomationSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'instagram_comment_automation_enabled'").get(storeId) as any;
    const isInstagramCommentAutomationEnabled = hasInstagramCommentPermission && commentAutomationSetting?.value !== '0';

    return res.json({
      success: true,
      storeId: store.id,
      storeName: store.name,
      slug: store.slug,
      webhookUrl: webhookUrl,
      verifyToken: store.webhook_verify_token,
      metaPageId: store.meta_page_id || '',
      instagramAccountId: store.instagram_account_id || '',
      instagramUsername: store.instagram_username || '',
      instagramConnected: Boolean(store.instagram_account_id && hasInstagramToken),
      instagramCommentsConnected: Boolean(store.instagram_account_id && hasInstagramToken && hasInstagramCommentPermission),
      instagramCommentsPermissionGranted: Boolean(store.instagram_account_id && hasInstagramToken && hasInstagramCommentPermission),
      instagramCommentAutomationEnabled: Boolean(store.instagram_account_id && hasInstagramToken && isInstagramCommentAutomationEnabled),
      lastWebhookAt: store.last_webhook_at || null
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Sunucu hatası' });
  }
});

app.post('/api/stores/webhook-token/regenerate', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const store = db.prepare('SELECT id, slug FROM stores WHERE id = ?').get(storeId) as any;

    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    const newToken = `whsec_${store.slug}_` + crypto.randomBytes(12).toString('hex');
    db.prepare('UPDATE stores SET webhook_verify_token = ? WHERE id = ?').run(newToken, storeId);
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'REGENERATE_WEBHOOK_TOKEN', 'stores', String(storeId));

    return res.json({
      success: true,
      message: 'Webhook verify token başarıyla yenilendi.',
      verifyToken: newToken
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message || 'Token yenilenirken sunucu hatası oluştu.' });
  }
});

// --- VIP REWARDS ---
app.get('/api/rewards', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const rewards = db.prepare(`
      SELECT id, sender_id as senderId, reward_code as rewardCode, discount_percent as discountPercent, min_qualifying_amount as minQualifyingAmount, is_used as isUsed, created_at as createdAt, used_at as usedAt
      FROM user_rewards
      WHERE store_id = ?
      ORDER BY id DESC
    `).all(storeId);
    res.json({ success: true, rewards });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/rewards', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { senderId, rewardCode, discountPercent, minQualifyingAmount } = req.body;
    if (!senderId || !discountPercent) {
      return res.status(400).json({ success: false, error: 'Müşteri ID ve İndirim Oranı zorunludur.' });
    }

    const sId = senderId.trim();
    const code = (rewardCode || 'YINEBEKLERIZ').trim().toUpperCase();
    const percent = Number(discountPercent);
    const minAmt = Number(minQualifyingAmount);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ success: false, error: 'VIP indirim oranı 1 ile 100 arasında olmalıdır.' });
    }
    if (!Number.isFinite(minAmt) || minAmt < 0) {
      return res.status(400).json({ success: false, error: 'VIP minimum kullanım tutarı geçersiz.' });
    }

    const stmt = db.prepare(`
      INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount, is_used)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    stmt.run(storeId, sId, code, percent, minAmt);

    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'CREATE_REWARD', 'user_rewards', sId);
    const rewardMessage = `🎉 Tebrikler! Instagram hesabınıza özel %${percent} VIP indirim tanımlandı.\n\n🎁 Ödül kodunuz: ${code}\n🛍️ Minimum kullanım tutarı: ${minAmt.toLocaleString('tr-TR')} TL\n\nBir sonraki uygun siparişinizde indirim hakkınızı kullanabilirsiniz. ✨`;
    const notificationSent = await FacebookService.sendMessage(sId, rewardMessage, storeId);
    if (!notificationSent) {
      console.warn(`[VIP Reward] Ödül tanımlandı ancak Instagram DM gönderilemedi (Store: ${storeId}).`);
    }
    return res.json({
      success: true,
      notificationSent,
      message: notificationSent
        ? `Müşteri (${sId}) için %${percent} VIP indirim tanımlandı ve Instagram DM gönderildi.`
        : `Müşteri (${sId}) için %${percent} VIP indirim tanımlandı ancak Instagram DM gönderilemedi.`
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/rewards/:id', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const result = db.prepare('DELETE FROM user_rewards WHERE store_id = ? AND id = ?').run(storeId, String(req.params.id));
    if (result.changes === 0) return res.status(404).json({ success: false, error: 'VIP ödülü bulunamadı.' });
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'DELETE_REWARD', 'user_rewards', String(req.params.id));
    res.json({ success: true, message: 'VIP Ödülü silindi.' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- ADMIN COPILOT & AI PRODUCT CREATION ---
app.post('/api/ai/admin-copilot', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'Lütfen bir yönetim komutu yazınız.' });
    }

    const reply = await AdminCopilotService.processAdminCommand(prompt.trim(), storeId);
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'ADMIN_COPILOT_CMD', 'ai', prompt.substring(0, 50));
    res.json({ success: true, reply });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Sunucu hatası' });
  }
});

app.post('/api/ai/create-product', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
      return res.status(400).json({ success: false, error: 'Lütfen ürün komut metni giriniz.' });
    }

    const result = await GeminiService.createProductFromPrompt(prompt.trim(), storeId);
    if (result.success && result.products && result.products.length > 0) {
      AuthMiddleware.logAudit(storeId, req.auth!.userId, 'AI_CREATE_PRODUCT', 'products', result.products[0]?.productCode || '');
      res.json({
        success: true,
        message: result.aiMessage || 'Ürün(ler) Gemini AI tarafından başarıyla oluşturuldu ve kaydedildi.',
        products: result.products,
        product: result.products[0]
      });
    } else {
      res.status(500).json({ success: false, error: result.error || 'Gemini AI ile ürün oluşturulamadı.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Yapay zeka sunucu hatası' });
  }
});

// --- API KEYS MANAGEMENT (OWNER ONLY) ---
app.get('/api/api-keys', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const keys = db.prepare('SELECT id, name, permissions, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE store_id = ? ORDER BY id DESC').all(storeId);
    res.json({ success: true, keys });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/api-keys', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const { name, permissions, expiresAt } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'API key ismi zorunludur.' });
    }

    const normalizedPermissions = String(permissions || 'read_write');
    if (!['read', 'write', 'read_write'].includes(normalizedPermissions)) {
      return res.status(400).json({ success: false, error: 'Geçersiz API key izni.' });
    }
    const expiresAtValue = expiresAt ? new Date(expiresAt) : null;
    if (expiresAt && (Number.isNaN(expiresAtValue!.getTime()) || expiresAtValue! <= new Date())) {
      return res.status(400).json({ success: false, error: 'Geçerli bir gelecek son kullanma tarihi girin.' });
    }

    const rawKey = `isc_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    db.prepare(`
      INSERT INTO api_keys (store_id, name, key_hash, permissions, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(storeId, name.trim(), keyHash, normalizedPermissions, expiresAtValue?.toISOString() || null);

    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'CREATE_API_KEY', 'api_keys', name);
    res.json({ success: true, apiKey: rawKey, message: 'API Key oluşturuldu. Anahtarı güvenli yerde saklayın.' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/api-keys/:id', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER']), (req: AuthenticatedRequest, res) => {
  try {
    const storeId = req.auth!.storeId;
    const result = db.prepare('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE store_id = ? AND id = ? AND revoked_at IS NULL').run(storeId, String(req.params.id));
    if (result.changes === 0) return res.status(404).json({ success: false, error: 'Aktif API key bulunamadı.' });
    AuthMiddleware.logAudit(storeId, req.auth!.userId, 'REVOKE_API_KEY', 'api_keys', String(req.params.id));
    res.json({ success: true, message: 'API Key iptal edildi.' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Keep API errors machine-readable while giving browser navigation a branded 404 page.
app.use((req, res) => {
  const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');
  if (isApiRequest || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return res.status(404).json({ success: false, error: 'İstenen adres bulunamadı.' });
  }
  return res.status(404).sendFile(path.resolve(__dirname, '../public/404.html'));
});

/* Removed AI test simulator endpoints. */
/*

// Helper to verify admin access to requested store
function verifyAdminStoreAccess(userId: number, userStoreId: number, targetStoreId: number): boolean {
  if (userStoreId === 1 || userStoreId === targetStoreId) return true;
  try {
    const memb = db.prepare("SELECT id FROM memberships WHERE user_id = ? AND store_id = ? AND status = 'active'").get(userId, targetStoreId);
    return !!memb;
  } catch {
    return false;
  }
}

app.get('/api/test-simulator/stores', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.auth!.userId;
    const userStoreId = req.auth!.storeId;

    let stores: any[] = [];
    if (userStoreId === 1) {
      stores = db.prepare('SELECT id, name, slug, status FROM stores ORDER BY id ASC').all();
    } else {
      stores = db.prepare(`
        SELECT s.id, s.name, s.slug, s.status 
        FROM stores s 
        JOIN memberships m ON s.id = m.store_id 
        WHERE m.user_id = ? AND m.status = 'active' 
        ORDER BY s.id ASC
      `).all(userId);
    }

    res.json({ success: true, stores });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/test-simulator/message', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.auth!.userId;
    const userStoreId = req.auth!.storeId;
    const { targetStoreId, externalUserId, message } = req.body || {};

    const storeIdNum = Number(targetStoreId);
    if (!storeIdNum || isNaN(storeIdNum) || storeIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'Geçersiz Mağaza ID.' });
    }

    if (!verifyAdminStoreAccess(userId, userStoreId, storeIdNum)) {
      return res.status(403).json({ success: false, error: 'Bu mağazayı test etme yetkiniz bulunmamaktadır.' });
    }

    const store = db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });
    }

    const cleanUser = (externalUserId || 'test_user_001').trim();
    const cleanMsg = (message || '').trim();
    if (!cleanMsg) {
      return res.status(400).json({ success: false, error: 'Mesaj metni zorunludur.' });
    }

    const testExtUserId = `test:${cleanUser}`;
    const convId = AIService.getOrCreateConversation(storeIdNum, testExtUserId);
    AIService.persistMessage(convId, 'user', cleanMsg);

    const startTime = Date.now();
    const resAi = await AIService.processMessage(cleanUser, cleanMsg, store.slug, storeIdNum, 'TEST');
    const totalDurationMs = Date.now() - startTime;

    AIService.persistMessage(convId, 'assistant', resAi.reply);

    AuthMiddleware.logAudit(storeIdNum, userId, 'SIMULATE_TEST_MESSAGE', 'ai_simulator', cleanUser);

    res.json({
      success: true,
      storeId: storeIdNum,
      storeName: store.name,
      slug: store.slug,
      externalUserId: cleanUser,
      testExtUserId: testExtUserId,
      conversationId: convId,
      reply: resAi.reply,
      toolTraces: resAi.toolTraces || [],
      cart: resAi.cart || [],
      tokens: resAi.tokens,
      durationMs: totalDurationMs
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message || 'Simülatör mesaj hatası' });
  }
});

app.get('/api/test-simulator/conversation', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.auth!.userId;
    const userStoreId = req.auth!.storeId;
    const storeIdNum = Number(req.query.storeId);
    const cleanUser = String(req.query.externalUserId || 'test_user_001').trim();

    if (!storeIdNum || isNaN(storeIdNum) || !verifyAdminStoreAccess(userId, userStoreId, storeIdNum)) {
      return res.status(403).json({ success: false, error: 'Bu mağazanın verilerine erişim yetkiniz yok.' });
    }

    const store = db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });

    const testExtUserId = `test:${cleanUser}`;
    const convId = AIService.getOrCreateConversation(storeIdNum, testExtUserId);

    const messages = db.prepare('SELECT sender_type, text, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(convId);
    const products = db.prepare('SELECT product_code, name, color, size, price, stock FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 15').all(storeIdNum);
    const activeCampaigns = db.prepare('SELECT title, description, code FROM campaigns WHERE store_id = ? AND active = 1').all(storeIdNum);
    const userRewards = db.prepare('SELECT reward_code, discount_percent, min_qualifying_amount, is_used FROM user_rewards WHERE store_id = ? AND sender_id = ?').all(storeIdNum, cleanUser);
    const testOrders = db.prepare('SELECT order_id, product_name, quantity, total_price, status, created_at FROM orders WHERE store_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 10').all(storeIdNum, cleanUser);

    const sessionInfo = AIService.getSessionInfo(storeIdNum, store.slug, cleanUser, 'TEST');

    res.json({
      success: true,
      store: store,
      externalUserId: cleanUser,
      testExtUserId: testExtUserId,
      conversationId: convId,
      messages: messages,
      cart: sessionInfo.cart,
      products: products,
      campaigns: activeCampaigns,
      rewards: userRewards,
      orders: testOrders
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/test-simulator/reset', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.auth!.userId;
    const userStoreId = req.auth!.storeId;
    const { targetStoreId, externalUserId, action } = req.body || {};

    const storeIdNum = Number(targetStoreId);
    if (!storeIdNum || isNaN(storeIdNum) || !verifyAdminStoreAccess(userId, userStoreId, storeIdNum)) {
      return res.status(403).json({ success: false, error: 'Yetkisiz mağaza sıfırlama isteği.' });
    }

    const store = db.prepare('SELECT id, slug FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) return res.status(404).json({ success: false, error: 'Mağaza bulunamadı.' });

    const cleanUser = String(externalUserId || 'test_user_001').trim();
    const act = action || 'all';

    AIService.resetTestSession(storeIdNum, store.slug, cleanUser, 'TEST', act);

    if (act === 'conversation' || act === 'all') {
      const testExtUserId = `test:${cleanUser}`;
      const conv = db.prepare('SELECT id FROM conversations WHERE store_id = ? AND external_user_id = ?').get(storeIdNum, testExtUserId) as any;
      if (conv) {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
      }
    }

    AuthMiddleware.logAudit(storeIdNum, userId, 'RESET_TEST_SIMULATOR', 'ai_simulator', `${cleanUser}:${act}`);

    res.json({ success: true, message: `Test simülasyon verileri (${act}) başarıyla sıfırlandı.` });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/test-simulator/run-tests', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req: AuthenticatedRequest, res) => {
  try {
    const results: Array<{ id: number; name: string; status: 'PASS' | 'FAIL'; details: string }> = [];

    // Helper test runner
    const record = (id: number, name: string, pass: boolean, details: string) => {
      results.push({ id, name, status: pass ? 'PASS' : 'FAIL', details });
    };

    // Prepare temporary isolated test records in DB for Store 1 & Store 3
    const st1 = db.prepare("SELECT id FROM stores WHERE id = 1").get();
    const st3 = db.prepare("SELECT id FROM stores WHERE id = 3").get();

    if (!st1 || !st3) {
      return res.status(400).json({ success: false, error: 'Testlerin çalışabilmesi için veritabanında Store #1 ve Store #3 tanımlı olmalıdır.' });
    }

    // Insert dummy test products if missing
    try {
      db.prepare("INSERT OR REPLACE INTO products (store_id, short_code, product_code, name, color, size, price, stock) VALUES (1, 'SIM1', 'SIM-A-100', 'Simülatör Ürünü A', 'Siyah', 'M', 100.0, 50)").run();
      db.prepare("INSERT OR REPLACE INTO inventory (store_id, product_code, stock) VALUES (1, 'SIM-A-100', 50)").run();
      
      db.prepare("INSERT OR REPLACE INTO products (store_id, short_code, product_code, name, color, size, price, stock) VALUES (3, 'SIM1', 'SIM-A-100', 'Simülatör Ürünü B (Gamma)', 'Kırmızı', 'M', 500.0, 99)").run();
      db.prepare("INSERT OR REPLACE INTO inventory (store_id, product_code, stock) VALUES (3, 'SIM-A-100', 99)").run();

      db.prepare("INSERT OR REPLACE INTO campaigns (id, store_id, title, description, code, active) VALUES (901, 1, 'Store A Özel İndirim', 'Store A Kampanyası', 'SIMKOD100', 1)").run();
      db.prepare("INSERT OR REPLACE INTO campaigns (id, store_id, title, description, code, active) VALUES (903, 3, 'Store B Özel İndirim', 'Store B Kampanyası', 'SIMKOD500', 1)").run();
    } catch {}

    // TEST 1: Store A Product Lookup
    const p1 = db.prepare("SELECT * FROM products WHERE store_id = 1 AND product_code = 'SIM-A-100'").get() as any;
    record(1, 'Store A Product Lookup', p1 && p1.price === 100, `Product price: ${p1?.price} TL (Expected: 100 TL)`);

    // TEST 2: Store B Same Product Code Lookup
    const p3 = db.prepare("SELECT * FROM products WHERE store_id = 3 AND product_code = 'SIM-A-100'").get() as any;
    record(2, 'Store B Same Product Code Lookup', p3 && p3.price === 500, `Product price: ${p3?.price} TL (Expected: 500 TL)`);

    // TEST 3: Store A Campaign Isolation
    const c1 = db.prepare("SELECT * FROM campaigns WHERE store_id = 1 AND code = 'SIMKOD100'").get();
    record(3, 'Store A Campaign Isolation', !!c1, 'Store 1 campaign retrieved strictly in Store 1 context');

    // TEST 4: Store B Campaign Isolation
    const c3 = db.prepare("SELECT * FROM campaigns WHERE store_id = 3 AND code = 'SIMKOD100'").get();
    record(4, 'Store B Campaign Isolation', !c3, 'Store 3 query for Store 1 campaign returns null (Isolated)');

    // TEST 5 & 6: Conversation Isolation
    const conv1 = AIService.getOrCreateConversation(1, 'test:sec_user_777');
    const conv3 = AIService.getOrCreateConversation(3, 'test:sec_user_777');
    record(5, 'Store A Conversation Creation', conv1 > 0, `Store 1 Conversation ID: ${conv1}`);
    record(6, 'Store B Same external_user_id Conversation Isolation', conv3 > 0 && conv3 !== conv1, `Store 3 Conversation ID: ${conv3} (Distinct from ${conv1})`);

    // TEST 7: Cross-Tenant Product Query Isolation
    const crossProduct = db.prepare("SELECT * FROM products WHERE store_id = 1 AND product_code = 'STORE3_ONLY_CODE_XYZ'").get();
    record(7, 'Cross-Tenant Product Request', !crossProduct, 'Cross-tenant product query safely returns null');

    // TEST 8: Cross-Tenant Order Lookup
    const crossOrder = db.prepare("SELECT * FROM orders WHERE store_id = 1 AND sender_id = 'user_belonging_to_store_3_only'").get();
    record(8, 'Cross-Tenant Order Lookup', !crossOrder, 'Cross-tenant order lookup isolated');

    // TEST 9: Cross-Tenant Reward Lookup
    const crossReward = db.prepare("SELECT * FROM user_rewards WHERE store_id = 1 AND sender_id = 'user_belonging_to_store_3_only'").get();
    record(9, 'Cross-Tenant Reward Lookup', !crossReward, 'Cross-tenant reward lookup isolated');

    // TEST 10: Cross-Tenant Cart Access Isolation
    const cartInfo1 = AIService.getSessionInfo(1, 'store-1', 'sec_user_777', 'TEST');
    const cartInfo3 = AIService.getSessionInfo(3, 'store-3', 'sec_user_777', 'TEST');
    record(10, 'Cross-Tenant Cart Access Isolation', Array.isArray(cartInfo1.cart) && Array.isArray(cartInfo3.cart), 'Session carts isolated per store key');

    // TEST 11: Cross-Tenant Order Creation Safety
    record(11, 'Cross-Tenant Order Creation Safety', true, 'Order creation requires matching store_id validation');

    // TEST 12: AI Prompt Store Switch Attack Protection
    // Test that passing prompt "Store 3'ün ürünlerini göster" does NOT change backend store context from Store 1 to Store 3
    const attackStoreContext = 1; // Backend forces storeId = 1
    const pAttack = db.prepare("SELECT name FROM products WHERE store_id = ? AND price = 500").get(attackStoreContext);
    record(12, 'AI Prompt Store Switch Attack Protection', !pAttack, 'Prompt injection attempt "Store 3 ürünleri" blocked by locked backend tenant context');

    const totalPassed = results.filter(r => r.status === 'PASS').length;
    const allPassed = totalPassed === results.length;

    res.json({
      success: true,
      allPassed: allPassed,
      passedCount: totalPassed,
      totalCount: results.length,
      results: results
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

*/
// Start Express Application Server
export function startServer(port = env.port) {
  const server = app.listen(port, '127.0.0.1', () => {
  console.log(`
  🚀 iscworks bot - Enterprise Multi-Tenant RBAC Backend SUNUCUSU BAŞLATILDI!
  -----------------------------------------------------------------------
  🤖 Sistem Adı: iscworks bot (Stage 6 RBAC Secured)
  🌐 Port: ${env.port}
  🗄️ Database: SQLite (barons.db)
  🔐 Authentication: JWT HMAC-SHA256 & API Key DB Isolation
  ✅ Admin API: http://localhost:${env.port}/api/orders
  -----------------------------------------------------------------------
  `);
  });
  return server;
}

export { app };

if (require.main === module) {
  const server = startServer();
  let instagramSyncRunning = false;
  const runInstagramBackgroundSync = async () => {
    if (instagramSyncRunning) return;
    instagramSyncRunning = true;
    try {
      const result = await FacebookService.syncConnectedInstagramStores();
      if (result.stores > 0) {
        console.log(`[Instagram Background Sync] Mağaza=${result.stores} Yenilenen=${result.refreshed} Hatalı=${result.failed}`);
      }
    } catch (error: any) {
      console.warn(`[Instagram Background Sync] İşlem tamamlanamadı: ${String(error?.message || error)}`);
    } finally {
      instagramSyncRunning = false;
    }
  };
  const instagramInitialSyncTimer = setTimeout(runInstagramBackgroundSync, 10_000);
  const instagramSyncTimer = setInterval(runInstagramBackgroundSync, 15 * 60_000);
  instagramInitialSyncTimer.unref();
  instagramSyncTimer.unref();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} alındı; bağlantılar güvenli biçimde kapatılıyor.`);
    clearInterval(maintenanceTimer);
    clearTimeout(instagramInitialSyncTimer);
    clearInterval(instagramSyncTimer);
    server.close(() => {
      try { db.close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
