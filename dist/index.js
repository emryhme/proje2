"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("./config/env");
const order_service_1 = require("./services/order.service");
const stock_service_1 = require("./services/stock.service");
const gemini_service_1 = require("./services/gemini.service");
const admin_copilot_service_1 = require("./services/admin-copilot.service");
const facebook_service_1 = require("./services/facebook.service");
const db_1 = require("./database/db");
const auth_middleware_1 = require("./middleware/auth.middleware");
// Initialize schema, migrations, and seed data once before serving requests.
(0, db_1.initDatabase)();
const app = (0, express_1.default)();
// Apply Global CORS Middleware
app.use(auth_middleware_1.AuthMiddleware.cors);
// Capture the exact bytes Meta signed before JSON parsing changes their form.
app.use(express_1.default.json({
    verify: (req, _res, buffer) => {
        req.rawBody = Buffer.from(buffer);
    }
}));
app.use(express_1.default.urlencoded({ extended: true }));
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
app.use(auth_routes_1.default);
// ==========================================
// MASTER ADMIN MERCHANT APPLICATION ROUTES
// ==========================================
// GET /api/admin/applications (Master Admin only - Store ID 1)
app.get('/api/admin/applications', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        if (req.auth.storeId !== 1) {
            return res.status(403).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurularÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â± yalnÃƒâ€Ã‚Â±zca SÃƒÆ’Ã‚Â¼per Admin yÃƒÆ’Ã‚Â¶netebilir.' });
        }
        const apps = db_1.db.prepare('SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications ORDER BY id DESC').all();
        return res.json({ success: true, applications: apps });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/admin/applications/:id/approve (Master Admin approve application)
app.post('/api/admin/applications/:id/approve', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        if (req.auth.storeId !== 1) {
            return res.status(403).json({ success: false, error: 'BaÃƒâ€¦Ã…Â¸vuru onaylama yetkisi sadece SÃƒÆ’Ã‚Â¼per Admin hesabÃƒâ€Ã‚Â±na aittir.' });
        }
        const appId = Number(req.params.id);
        const appRow = db_1.db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId);
        if (!appRow) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE merchant_applications SET status = \'approved\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
            db_1.db.prepare('UPDATE users SET status = \'active\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
            const userRow = db_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase());
            if (userRow) {
                db_1.db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
                db_1.db.prepare('UPDATE memberships SET status = \'active\' WHERE user_id = ?').run(userRow.id);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'APPROVE_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
        })();
        return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla onaylandÃƒâ€Ã‚Â± ve aktifleÃƒâ€¦Ã…Â¸ti!` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// POST /api/admin/applications/:id/reject (Master Admin reject application)
app.post('/api/admin/applications/:id/reject', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        if (req.auth.storeId !== 1) {
            return res.status(403).json({ success: false, error: 'BaÃƒâ€¦Ã…Â¸vuru reddetme yetkisi sadece SÃƒÆ’Ã‚Â¼per Admin hesabÃƒâ€Ã‚Â±na aittir.' });
        }
        const appId = Number(req.params.id);
        const appRow = db_1.db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId);
        if (!appRow) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
        }
        db_1.db.transaction(() => {
            db_1.db.prepare('UPDATE merchant_applications SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
            db_1.db.prepare('UPDATE users SET status = \'rejected\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
            const userRow = db_1.db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase());
            if (userRow) {
                db_1.db.prepare('UPDATE stores SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
                db_1.db.prepare('UPDATE memberships SET status = \'rejected\' WHERE user_id = ?').run(userRow.id);
            }
            auth_middleware_1.AuthMiddleware.logAudit(1, req.auth.userId, 'REJECT_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
        })();
        return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu reddedildi.` });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
// ==========================================
const integration_routes_1 = __importDefault(require("./routes/integration.routes"));
app.use(integration_routes_1.default);
// Static Admin UI Server (Merchant Panel)
app.use('/admin', express_1.default.static(path_1.default.resolve(__dirname, '../public/admin')));
app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/admin/index.html'));
});
app.get(['/admin/login', '/admin/login.html'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/admin/login.html'));
});
// Static Master Admin UI Server (Platform Owner Panel)
app.use('/master-admin', express_1.default.static(path_1.default.resolve(__dirname, '../public/master-admin')));
// Keep the trailing slash on the console root so relative static assets resolve correctly.
app.get('/master-admin', (req, res) => {
    res.redirect(302, '/master-admin/');
});
app.get('/master-admin/', (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/master-admin/index.html'));
});
app.get(['/master-admin/login', '/master-admin/login.html'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/master-admin/login.html'));
});
app.get(['/master-admin/merchants', '/master-admin/merchants.html'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/master-admin/merchants.html'));
});
app.get(['/master-admin/merchant', '/master-admin/merchant.html'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/master-admin/merchant.html'));
});
app.get(['/master-admin/applications', '/master-admin/applications.html'], (req, res) => {
    res.sendFile(path_1.default.resolve(__dirname, '../public/master-admin/applications.html'));
});
// ==========================================
const master_admin_routes_1 = __importDefault(require("./routes/master-admin.routes"));
app.use(master_admin_routes_1.default);
app.use('/', express_1.default.static(path_1.default.resolve(__dirname, '../public')));
// --- PRODUCTS & STOCKS ---
app.get('/api/stocks', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req, res) => {
    const storeId = req.auth.storeId;
    const stocks = await stock_service_1.StockService.getAllProducts(storeId);
    res.json({ success: true, stocks });
});
app.get('/api/stock/:code', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req, res) => {
    const storeId = req.auth.storeId;
    const result = await stock_service_1.StockService.checkStock(storeId, String(req.params.code));
    res.json(result);
});
app.post('/api/products', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { shortCode, productCode, name, color, size, stock, price, category, storeName } = req.body || {};
        if (!shortCode || !name || !size) {
            return res.status(400).json({ success: false, error: 'KÃƒâ€Ã‚Â±sa kod, ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼n ismi ve beden/numara alanlarÃƒâ€Ã‚Â± zorunludur.' });
        }
        const result = await stock_service_1.StockService.addProduct({
            storeId,
            shortCode,
            productCode,
            name,
            color: color || 'Standart',
            size,
            stock: stock ? Number(stock) : 0,
            price: price ? Number(price) : 299,
            category: category || 'Genel',
            storeName: storeName || ''
        });
        if (result.success) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'ADD_PRODUCT', 'products', result.productCode || '');
            res.json({
                success: true,
                message: 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n maÃƒâ€Ã…Â¸aza stok veritabanÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±za baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla eklendi!',
                productCode: result.productCode
            });
        }
        else {
            res.status(500).json({ success: false, error: 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n veritabanÃƒâ€Ã‚Â±na kaydedilemedi.' });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
app.post('/api/products/price', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { productCode, price } = req.body;
        if (!productCode || price === undefined) {
            return res.status(400).json({ success: false, error: 'productCode ve price zorunludur.' });
        }
        const numPrice = Number(price);
        if (isNaN(numPrice) || numPrice < 0) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz fiyat.' });
        }
        const stmt = db_1.db.prepare('UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND (product_code = ? OR short_code = ?)');
        const result = stmt.run(numPrice, storeId, productCode, productCode);
        if (result.changes > 0) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'UPDATE_PRICE', 'products', productCode, '', String(numPrice));
            res.json({ success: true, message: `ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n (${productCode}) fiyatÃƒâ€Ã‚Â± ${numPrice} TL olarak gÃƒÆ’Ã‚Â¼ncellendi.` });
        }
        else {
            res.status(404).json({ success: false, error: 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n bu maÃƒâ€Ã…Â¸azada bulunamadÃƒâ€Ã‚Â±.' });
        }
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/api/products/bulk-update', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { updates } = req.body;
        if (!Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({ success: false, error: 'GÃƒÆ’Ã‚Â¼ncellenecek veri listesi boÃƒâ€¦Ã…Â¸ veya geÃƒÆ’Ã‚Â§ersiz.' });
        }
        const updatePriceStmt = db_1.db.prepare('UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_code = ?');
        const updateStockStmt = db_1.db.prepare('UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND product_code = ?');
        let updatedCount = 0;
        const bulkTransaction = db_1.db.transaction((items) => {
            for (const item of items) {
                if (item.productCode) {
                    const cleanCode = String(item.productCode).trim().toUpperCase();
                    if (item.price !== undefined && !isNaN(Number(item.price)) && Number(item.price) >= 0) {
                        const resPrice = updatePriceStmt.run(Number(item.price), storeId, cleanCode);
                        if (resPrice.changes > 0)
                            updatedCount++;
                    }
                    if (item.stock !== undefined && !isNaN(Number(item.stock)) && Number(item.stock) >= 0) {
                        const stockNum = Number(item.stock);
                        const resStock = updateStockStmt.run(stockNum, storeId, cleanCode);
                        if (resStock.changes > 0) {
                            updatedCount++;
                            try {
                                let inv = db_1.db.prepare('SELECT id FROM inventory WHERE store_id = ? AND UPPER(product_code) = ?').get(storeId, cleanCode);
                                if (inv) {
                                    db_1.db.prepare('UPDATE inventory SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stockNum, inv.id);
                                }
                                else {
                                    db_1.db.prepare('INSERT INTO inventory (store_id, product_code, stock, reserved_stock, updated_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)').run(storeId, cleanCode, stockNum);
                                }
                            }
                            catch (e) { }
                        }
                    }
                }
            }
        });
        bulkTransaction(updates);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'BULK_UPDATE_PRODUCTS', 'products', `${updates.length} items`);
        if (updatedCount === 0) {
            return res.status(404).json({ success: false, error: 'Belirtilen ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼nler bu maÃƒâ€Ã…Â¸azada bulunamadÃƒâ€Ã‚Â± veya gÃƒÆ’Ã‚Â¼ncelleme yapÃƒâ€Ã‚Â±lamadÃƒâ€Ã‚Â±.' });
        }
        return res.json({ success: true, message: `${updatedCount} adet gÃƒÆ’Ã‚Â¼ncelleme baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla kaydedildi!`, updatedCount });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/api/products/delete', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { productCode } = req.body;
        if (!productCode) {
            return res.status(400).json({ success: false, error: 'productCode parametresi gereklidir' });
        }
        const success = await stock_service_1.StockService.deleteProduct(storeId, productCode);
        if (success) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'DELETE_PRODUCT', 'products', productCode);
            return res.json({ success: true, message: `ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n (${productCode}) silindi.` });
        }
        else {
            return res.status(404).json({ success: false, error: 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n bu maÃƒâ€Ã…Â¸azada bulunamadÃƒâ€Ã‚Â± veya silinemedi.' });
        }
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
app.post('/api/products/update-stock', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { productCode, newStock } = req.body;
        if (!productCode || newStock === undefined || newStock === null) {
            return res.status(400).json({ success: false, error: 'productCode ve newStock parametreleri gereklidir' });
        }
        const numStock = Number(newStock);
        if (isNaN(numStock) || numStock < 0) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz stok miktarÃƒâ€Ã‚Â±. Stok 0 veya pozitif bir sayÃƒâ€Ã‚Â± olmalÃƒâ€Ã‚Â±dÃƒâ€Ã‚Â±r.' });
        }
        const success = await stock_service_1.StockService.updateStock(storeId, String(productCode), numStock);
        if (success) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'UPDATE_STOCK', 'products', String(productCode), '', String(numStock));
            return res.json({ success: true, message: `ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n (${productCode}) stoÃƒâ€Ã…Â¸u ${numStock} olarak gÃƒÆ’Ã‚Â¼ncellendi.`, productCode, stock: numStock });
        }
        else {
            return res.status(404).json({ success: false, error: 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n bu maÃƒâ€Ã…Â¸azada bulunamadÃƒâ€Ã‚Â± veya stok gÃƒÆ’Ã‚Â¼ncellenemedi.' });
        }
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
// --- ORDERS ---
app.get('/api/orders', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req, res) => {
    const storeId = req.auth.storeId;
    const orders = await order_service_1.OrderService.getOrders(storeId);
    res.json({ success: true, count: orders.length, orders });
});
app.post('/api/orders/status', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { orderId, status, reason } = req.body;
        if (!orderId || !status || (status !== 'OK' && status !== 'DEC')) {
            return res.status(400).json({ success: false, error: 'orderId ve geÃƒÆ’Ã‚Â§erli bir status (OK veya DEC) gereklidir' });
        }
        const success = await order_service_1.OrderService.updateOrderStatus(storeId, orderId, status, reason);
        if (success) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'UPDATE_ORDER_STATUS', 'orders', orderId, '', status);
            res.json({
                success: true,
                message: `SipariÃƒâ€¦Ã…Â¸ ${orderId} durumu '${status}' olarak gÃƒÆ’Ã‚Â¼ncellendi.`,
                orderId,
                status
            });
        }
        else {
            res.status(500).json({ success: false, error: 'SipariÃƒâ€¦Ã…Â¸ durumu gÃƒÆ’Ã‚Â¼ncellenemedi.' });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
app.post('/api/orders/delete', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ success: false, error: 'orderId parametresi gereklidir' });
        }
        const success = await order_service_1.OrderService.deleteOrder(storeId, orderId);
        if (success) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'DELETE_ORDER', 'orders', orderId);
            res.json({ success: true, message: `SipariÃƒâ€¦Ã…Â¸ (${orderId}) silindi.` });
        }
        else {
            res.status(500).json({ success: false, error: 'SipariÃƒâ€¦Ã…Â¸ silinemedi.' });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
// --- CAMPAIGNS ---
app.get('/api/campaigns', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const campaigns = db_1.db.prepare('SELECT * FROM campaigns WHERE store_id = ? ORDER BY id DESC').all(storeId);
        return res.json({ success: true, campaigns });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Kampanyalar alÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±rken sunucu hatasÃƒâ€Ã‚Â± oluÃƒâ€¦Ã…Â¸tu.' });
    }
});
app.post('/api/campaigns', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { title, description, code, discountPercent, discountAmount, minOrderAmount, startDate, endDate } = req.body || {};
        if (!title || !String(title).trim() || !description || !String(description).trim()) {
            return res.status(400).json({ success: false, error: 'Kampanya baÃƒâ€¦Ã…Â¸lÃƒâ€Ã‚Â±Ãƒâ€Ã…Â¸Ãƒâ€Ã‚Â± ve aÃƒÆ’Ã‚Â§Ãƒâ€Ã‚Â±klamasÃƒâ€Ã‚Â± zorunludur.' });
        }
        const cleanTitle = String(title).trim();
        const cleanDesc = String(description).trim();
        const cleanCode = code ? String(code).trim().toUpperCase() : '';
        const numPercent = discountPercent !== undefined ? Number(discountPercent) : 0;
        const numAmount = discountAmount !== undefined ? Number(discountAmount) : 0;
        const numMinOrder = minOrderAmount !== undefined ? Number(minOrderAmount) : 0;
        if (isNaN(numPercent) || numPercent < 0) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz indirim yÃƒÆ’Ã‚Â¼zdesi.' });
        }
        const stmt = db_1.db.prepare(`
      INSERT INTO campaigns (store_id, title, description, code, discount_percent, discount_amount, min_order_amount, start_date, end_date, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
        const result = stmt.run(storeId, cleanTitle, cleanDesc, cleanCode, numPercent, numAmount, numMinOrder, startDate || null, endDate || null);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'CREATE_CAMPAIGN', 'campaigns', cleanCode || cleanTitle);
        return res.status(201).json({
            success: true,
            message: 'Kampanya baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla oluÃƒâ€¦Ã…Â¸turuldu.',
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
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Kampanya oluÃƒâ€¦Ã…Â¸turulurken veritabanÃƒâ€Ã‚Â± hatasÃƒâ€Ã‚Â± oluÃƒâ€¦Ã…Â¸tu.' });
    }
});
app.post('/api/campaigns/toggle', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { id, active } = req.body || {};
        if (!id) {
            return res.status(400).json({ success: false, error: 'Kampanya id zorunludur.' });
        }
        const newActive = active ? 1 : 0;
        const result = db_1.db.prepare('UPDATE campaigns SET active = ? WHERE store_id = ? AND id = ?').run(newActive, storeId, String(id));
        if (result.changes > 0) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'TOGGLE_CAMPAIGN', 'campaigns', String(id), '', String(newActive));
            return res.json({ success: true, message: 'Kampanya durumu gÃƒÆ’Ã‚Â¼ncellendi.', active: newActive });
        }
        else {
            return res.status(404).json({ success: false, error: 'Kampanya bulunamadÃƒâ€Ã‚Â± veya bu maÃƒâ€Ã…Â¸azaya ait deÃƒâ€Ã…Â¸il.' });
        }
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Kampanya gÃƒÆ’Ã‚Â¼ncellenemedi.' });
    }
});
app.delete('/api/campaigns/:id', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const campaignId = String(req.params.id);
        const result = db_1.db.prepare('DELETE FROM campaigns WHERE store_id = ? AND id = ?').run(storeId, campaignId);
        if (result.changes > 0) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'DELETE_CAMPAIGN', 'campaigns', campaignId);
            return res.json({ success: true, message: 'Kampanya silindi.' });
        }
        else {
            return res.status(404).json({ success: false, error: 'Kampanya bulunamadÃƒâ€Ã‚Â± veya bu maÃƒâ€Ã…Â¸azaya ait deÃƒâ€Ã…Â¸il.' });
        }
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Kampanya silinirken hata oluÃƒâ€¦Ã…Â¸tu.' });
    }
});
// --- SETTINGS ---
app.get('/api/settings', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const rows = db_1.db.prepare('SELECT * FROM settings WHERE store_id = ?').all(storeId);
        const settingsObj = {};
        for (const r of rows) {
            if (r && r.key) {
                settingsObj[r.key] = r.value || '';
            }
        }
        res.json({ success: true, settings: settingsObj, settingsList: rows });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message, settings: {} });
    }
});
app.post('/api/settings', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { key, value, settings, shippingFee, freeShippingThreshold } = req.body;
        if (key && value !== undefined) {
            db_1.db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)').run(storeId, String(key), String(value));
        }
        if (shippingFee !== undefined) {
            db_1.db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, "shipping_fee", ?)').run(storeId, String(shippingFee));
        }
        if (freeShippingThreshold !== undefined) {
            db_1.db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, "free_shipping_threshold", ?)').run(storeId, String(freeShippingThreshold));
        }
        if (settings && typeof settings === 'object') {
            for (const [k, v] of Object.entries(settings)) {
                const settingKey = String(k);
                let settingValue = String(v ?? '');
                if (settingKey === 'bot_name') {
                    settingValue = settingValue.trim().slice(0, 40);
                    if (!settingValue)
                        return res.status(400).json({ success: false, error: 'Yapay zeka asistan adı boş bırakılamaz.' });
                }
                else if (settingKey === 'bot_tone') {
                    if (!['luxury', 'friendly', 'formal', 'patron'].includes(settingValue)) {
                        return res.status(400).json({ success: false, error: 'Geçersiz yapay zeka kişilik üslubu.' });
                    }
                }
                else if (settingKey === 'bot_system_prompt') {
                    settingValue = settingValue.trim().slice(0, 4000);
                }
                db_1.db.prepare('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, ?, ?)').run(storeId, settingKey, settingValue);
            }
        }
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'UPDATE_SETTINGS', 'settings', 'all');
        res.json({ success: true, message: 'Ayarlar gÃƒÆ’Ã‚Â¼ncellendi.' });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.get('/api/stores/webhook-info', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        let store = db_1.db.prepare('SELECT id, name, slug, status, meta_page_id, instagram_account_id, instagram_username, last_webhook_at, webhook_verify_token FROM stores WHERE id = ?').get(storeId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        if (!store.webhook_verify_token) {
            const newToken = `whsec_${store.slug}_` + crypto_1.default.randomBytes(12).toString('hex');
            db_1.db.prepare('UPDATE stores SET webhook_verify_token = ? WHERE id = ?').run(newToken, storeId);
            store.webhook_verify_token = newToken;
        }
        const host = req.get('host') || '136.92.8.201:3000';
        const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
        const webhookUrl = `${protocol}://${host}/api/webhook/${store.slug}`;
        const hasInstagramToken = !!db_1.db.prepare("SELECT 1 FROM settings WHERE store_id = ? AND key = 'instagram_access_token'").get(storeId);
        const hasInstagramCommentPermission = !!db_1.db.prepare(`
      SELECT 1 FROM settings
      WHERE store_id = ?
        AND key IN ('instagram_comment_permission_granted', 'instagram_comment_access_enabled')
        AND value = '1'
    `).get(storeId);
        const commentAutomationSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'instagram_comment_automation_enabled'").get(storeId);
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
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
app.post('/api/stores/webhook-token/regenerate', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const store = db_1.db.prepare('SELECT id, slug FROM stores WHERE id = ?').get(storeId);
        if (!store) {
            return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
        }
        const newToken = `whsec_${store.slug}_` + crypto_1.default.randomBytes(12).toString('hex');
        db_1.db.prepare('UPDATE stores SET webhook_verify_token = ? WHERE id = ?').run(newToken, storeId);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'REGENERATE_WEBHOOK_TOKEN', 'stores', String(storeId));
        return res.json({
            success: true,
            message: 'Webhook verify token baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla yenilendi.',
            verifyToken: newToken
        });
    }
    catch (e) {
        return res.status(500).json({ success: false, error: e.message || 'Token yenilenirken sunucu hatasÃƒâ€Ã‚Â± oluÃƒâ€¦Ã…Â¸tu.' });
    }
});
// --- VIP REWARDS ---
app.get('/api/rewards', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const rewards = db_1.db.prepare(`
      SELECT id, sender_id as senderId, reward_code as rewardCode, discount_percent as discountPercent, min_qualifying_amount as minQualifyingAmount, is_used as isUsed, created_at as createdAt, used_at as usedAt
      FROM user_rewards
      WHERE store_id = ?
      ORDER BY id DESC
    `).all(storeId);
        res.json({ success: true, rewards });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/api/rewards', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { senderId, rewardCode, discountPercent, minQualifyingAmount } = req.body;
        if (!senderId || !discountPercent) {
            return res.status(400).json({ success: false, error: 'MÃƒÆ’Ã‚Â¼Ãƒâ€¦Ã…Â¸teri ID ve Ãƒâ€Ã‚Â°ndirim OranÃƒâ€Ã‚Â± zorunludur.' });
        }
        const sId = senderId.trim();
        const code = (rewardCode || 'YINEBEKLERIZ').trim().toUpperCase();
        const percent = Number(discountPercent) || 20;
        const minAmt = Number(minQualifyingAmount) || 2000;
        const stmt = db_1.db.prepare(`
      INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount, is_used)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
        stmt.run(storeId, sId, code, percent, minAmt);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'CREATE_REWARD', 'user_rewards', sId);
        const rewardMessage = `🎉 Tebrikler! Instagram hesabınıza özel %${percent} VIP indirim tanımlandı.\n\n🎁 Ödül kodunuz: ${code}\n🛍️ Minimum kullanım tutarı: ${minAmt.toLocaleString('tr-TR')} TL\n\nBir sonraki uygun siparişinizde indirim hakkınızı kullanabilirsiniz. ✨`;
        const notificationSent = await facebook_service_1.FacebookService.sendMessage(sId, rewardMessage, storeId);
        if (!notificationSent) {
            console.warn(`[VIP Reward] Ödül tanımlandı ancak Instagram DM gönderilemedi (Store: ${storeId}, Sender: ${sId}, Code: ${code}).`);
        }
        return res.json({
            success: true,
            notificationSent,
            message: notificationSent
                ? `Müşteri (${sId}) için %${percent} VIP indirim tanımlandı ve Instagram DM gönderildi.`
                : `Müşteri (${sId}) için %${percent} VIP indirim tanımlandı ancak Instagram DM gönderilemedi.`
        });
        res.json({ success: true, message: `MÃƒÆ’Ã‚Â¼Ãƒâ€¦Ã…Â¸teri (${sId}) iÃƒÆ’Ã‚Â§in %${percent} VIP indirim tanÃƒâ€Ã‚Â±mlandÃƒâ€Ã‚Â±.` });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.delete('/api/rewards/:id', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        db_1.db.prepare('DELETE FROM user_rewards WHERE store_id = ? AND id = ?').run(storeId, String(req.params.id));
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'DELETE_REWARD', 'user_rewards', String(req.params.id));
        res.json({ success: true, message: 'VIP ÃƒÆ’Ã¢â‚¬â€œdÃƒÆ’Ã‚Â¼lÃƒÆ’Ã‚Â¼ silindi.' });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
// --- ADMIN COPILOT & AI PRODUCT CREATION ---
app.post('/api/ai/admin-copilot', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { prompt } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'LÃƒÆ’Ã‚Â¼tfen bir yÃƒÆ’Ã‚Â¶netim komutu yazÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±z.' });
        }
        const reply = await admin_copilot_service_1.AdminCopilotService.processAdminCommand(prompt.trim(), storeId);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'ADMIN_COPILOT_CMD', 'ai', prompt.substring(0, 50));
        res.json({ success: true, reply });
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
app.post('/api/ai/create-product', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER']), async (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
            return res.status(400).json({ success: false, error: 'LÃƒÆ’Ã‚Â¼tfen ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼n komut metni giriniz.' });
        }
        const result = await gemini_service_1.GeminiService.createProductFromPrompt(prompt.trim(), storeId);
        if (result.success && result.products && result.products.length > 0) {
            auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'AI_CREATE_PRODUCT', 'products', result.products[0]?.productCode || '');
            res.json({
                success: true,
                message: result.aiMessage || 'ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼n(ler) Gemini AI tarafÃƒâ€Ã‚Â±ndan baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla oluÃƒâ€¦Ã…Â¸turuldu ve kaydedildi.',
                products: result.products,
                product: result.products[0]
            });
        }
        else {
            res.status(500).json({ success: false, error: result.error || 'Gemini AI ile ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼n oluÃƒâ€¦Ã…Â¸turulamadÃƒâ€Ã‚Â±.' });
        }
    }
    catch (err) {
        res.status(500).json({ success: false, error: err.message || 'Yapay zeka sunucu hatasÃƒâ€Ã‚Â±' });
    }
});
// --- API KEYS MANAGEMENT (OWNER ONLY) ---
app.get('/api/api-keys', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const keys = db_1.db.prepare('SELECT id, name, permissions, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE store_id = ? ORDER BY id DESC').all(storeId);
        res.json({ success: true, keys });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.post('/api/api-keys', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const { name, permissions, expiresAt } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'API key ismi zorunludur.' });
        }
        const normalizedPermissions = String(permissions || 'read_write');
        if (!['read', 'write', 'read_write'].includes(normalizedPermissions)) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz API key izni.' });
        }
        const expiresAtValue = expiresAt ? new Date(expiresAt) : null;
        if (expiresAt && (Number.isNaN(expiresAtValue.getTime()) || expiresAtValue <= new Date())) {
            return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§erli bir gelecek son kullanma tarihi girin.' });
        }
        const rawKey = `isc_live_${crypto_1.default.randomBytes(24).toString('hex')}`;
        const keyHash = crypto_1.default.createHash('sha256').update(rawKey).digest('hex');
        db_1.db.prepare(`
      INSERT INTO api_keys (store_id, name, key_hash, permissions, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(storeId, name.trim(), keyHash, normalizedPermissions, expiresAtValue?.toISOString() || null);
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'CREATE_API_KEY', 'api_keys', name);
        res.json({ success: true, apiKey: rawKey, message: 'API Key oluÃƒâ€¦Ã…Â¸turuldu. AnahtarÃƒâ€Ã‚Â± gÃƒÆ’Ã‚Â¼venli yerde saklayÃƒâ€Ã‚Â±n.' });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
app.delete('/api/api-keys/:id', auth_middleware_1.AuthMiddleware.authenticate, auth_middleware_1.AuthMiddleware.requireRole(['OWNER']), (req, res) => {
    try {
        const storeId = req.auth.storeId;
        const result = db_1.db.prepare('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE store_id = ? AND id = ? AND revoked_at IS NULL').run(storeId, String(req.params.id));
        if (result.changes === 0)
            return res.status(404).json({ success: false, error: 'Aktif API key bulunamadÃƒâ€Ã‚Â±.' });
        auth_middleware_1.AuthMiddleware.logAudit(storeId, req.auth.userId, 'REVOKE_API_KEY', 'api_keys', String(req.params.id));
        res.json({ success: true, message: 'API Key iptal edildi.' });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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
      return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz MaÃƒâ€Ã…Â¸aza ID.' });
    }

    if (!verifyAdminStoreAccess(userId, userStoreId, storeIdNum)) {
      return res.status(403).json({ success: false, error: 'Bu maÃƒâ€Ã…Â¸azayÃƒâ€Ã‚Â± test etme yetkiniz bulunmamaktadÃƒâ€Ã‚Â±r.' });
    }

    const store = db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
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
    res.status(500).json({ success: false, error: e.message || 'SimÃƒÆ’Ã‚Â¼latÃƒÆ’Ã‚Â¶r mesaj hatasÃƒâ€Ã‚Â±' });
  }
});

app.get('/api/test-simulator/conversation', AuthMiddleware.authenticate, AuthMiddleware.requireRole(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']), (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.auth!.userId;
    const userStoreId = req.auth!.storeId;
    const storeIdNum = Number(req.query.storeId);
    const cleanUser = String(req.query.externalUserId || 'test_user_001').trim();

    if (!storeIdNum || isNaN(storeIdNum) || !verifyAdminStoreAccess(userId, userStoreId, storeIdNum)) {
      return res.status(403).json({ success: false, error: 'Bu maÃƒâ€Ã…Â¸azanÃƒâ€Ã‚Â±n verilerine eriÃƒâ€¦Ã…Â¸im yetkiniz yok.' });
    }

    const store = db.prepare('SELECT id, name, slug, status FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });

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
      return res.status(403).json({ success: false, error: 'Yetkisiz maÃƒâ€Ã…Â¸aza sÃƒâ€Ã‚Â±fÃƒâ€Ã‚Â±rlama isteÃƒâ€Ã…Â¸i.' });
    }

    const store = db.prepare('SELECT id, slug FROM stores WHERE id = ?').get(storeIdNum) as any;
    if (!store) return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });

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

    res.json({ success: true, message: `Test simÃƒÆ’Ã‚Â¼lasyon verileri (${act}) baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla sÃƒâ€Ã‚Â±fÃƒâ€Ã‚Â±rlandÃƒâ€Ã‚Â±.` });
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
      return res.status(400).json({ success: false, error: 'Testlerin ÃƒÆ’Ã‚Â§alÃƒâ€Ã‚Â±Ãƒâ€¦Ã…Â¸abilmesi iÃƒÆ’Ã‚Â§in veritabanÃƒâ€Ã‚Â±nda Store #1 ve Store #3 tanÃƒâ€Ã‚Â±mlÃƒâ€Ã‚Â± olmalÃƒâ€Ã‚Â±dÃƒâ€Ã‚Â±r.' });
    }

    // Insert dummy test products if missing
    try {
      db.prepare("INSERT OR REPLACE INTO products (store_id, short_code, product_code, name, color, size, price, stock) VALUES (1, 'SIM1', 'SIM-A-100', 'SimÃƒÆ’Ã‚Â¼latÃƒÆ’Ã‚Â¶r ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼nÃƒÆ’Ã‚Â¼ A', 'Siyah', 'M', 100.0, 50)").run();
      db.prepare("INSERT OR REPLACE INTO inventory (store_id, product_code, stock) VALUES (1, 'SIM-A-100', 50)").run();
      
      db.prepare("INSERT OR REPLACE INTO products (store_id, short_code, product_code, name, color, size, price, stock) VALUES (3, 'SIM1', 'SIM-A-100', 'SimÃƒÆ’Ã‚Â¼latÃƒÆ’Ã‚Â¶r ÃƒÆ’Ã…â€œrÃƒÆ’Ã‚Â¼nÃƒÆ’Ã‚Â¼ B (Gamma)', 'KÃƒâ€Ã‚Â±rmÃƒâ€Ã‚Â±zÃƒâ€Ã‚Â±', 'M', 500.0, 99)").run();
      db.prepare("INSERT OR REPLACE INTO inventory (store_id, product_code, stock) VALUES (3, 'SIM-A-100', 99)").run();

      db.prepare("INSERT OR REPLACE INTO campaigns (id, store_id, title, description, code, active) VALUES (901, 1, 'Store A ÃƒÆ’Ã¢â‚¬â€œzel Ãƒâ€Ã‚Â°ndirim', 'Store A KampanyasÃƒâ€Ã‚Â±', 'SIMKOD100', 1)").run();
      db.prepare("INSERT OR REPLACE INTO campaigns (id, store_id, title, description, code, active) VALUES (903, 3, 'Store B ÃƒÆ’Ã¢â‚¬â€œzel Ãƒâ€Ã‚Â°ndirim', 'Store B KampanyasÃƒâ€Ã‚Â±', 'SIMKOD500', 1)").run();
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
    // Test that passing prompt "Store 3'ÃƒÆ’Ã‚Â¼n ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼nlerini gÃƒÆ’Ã‚Â¶ster" does NOT change backend store context from Store 1 to Store 3
    const attackStoreContext = 1; // Backend forces storeId = 1
    const pAttack = db.prepare("SELECT name FROM products WHERE store_id = ? AND price = 500").get(attackStoreContext);
    record(12, 'AI Prompt Store Switch Attack Protection', !pAttack, 'Prompt injection attempt "Store 3 ÃƒÆ’Ã‚Â¼rÃƒÆ’Ã‚Â¼nleri" blocked by locked backend tenant context');

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
app.listen(env_1.env.port, '127.0.0.1', () => {
    console.log(`
  Ã„Å¸Ã…Â¸Ã…Â¡Ã¢â€šÂ¬ iscworks bot - Enterprise Multi-Tenant RBAC Backend SUNUCUSU BAÃƒâ€¦Ã‚ÂLATILDI!
  -----------------------------------------------------------------------
  Ã„Å¸Ã…Â¸Ã‚Â¤Ã¢â‚¬â€œ Sistem AdÃƒâ€Ã‚Â±: iscworks bot (Stage 6 RBAC Secured)
  Ã„Å¸Ã…Â¸Ã…â€™Ã‚Â Port: ${env_1.env.port}
  Ã„Å¸Ã…Â¸Ã¢â‚¬â€Ã¢â‚¬ÂÃƒÂ¯Ã‚Â¸Ã‚Â Database: SQLite (barons.db)
  Ã„Å¸Ã…Â¸Ã¢â‚¬ÂÃ‚Â Authentication: JWT HMAC-SHA256 & API Key DB Isolation
  Ã„Å¸Ã…Â¸Ã¢â‚¬Å“Ã…Â  Admin API: http://localhost:${env_1.env.port}/api/orders
  -----------------------------------------------------------------------
  `);
});
