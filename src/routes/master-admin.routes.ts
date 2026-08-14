import { Router } from 'express';
import { db } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();
const ALLOWED_PLANS = ['Starter Store', 'Pro Store', 'Enterprise Store'];

// MASTER ADMIN API ENDPOINTS (/api/master-admin/*)
// Strictly enforced with AuthMiddleware.requireMasterAdmin
// ==========================================

// GET /api/master-admin/dashboard
router.get('/api/master-admin/dashboard', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const totalMerchants = (db.prepare("SELECT COUNT(*) as count FROM stores WHERE id != 1").get() as any).count;
    const activeStores = (db.prepare("SELECT COUNT(*) as count FROM stores WHERE status = 'active' AND id != 1").get() as any).count;
    const pendingApplications = (db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'pending'").get() as any).count;
    const suspendedStores = (db.prepare("SELECT COUNT(*) as count FROM stores WHERE status = 'suspended'").get() as any).count;
    const totalUsers = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
    const totalOrders = (db.prepare("SELECT COUNT(*) as count FROM orders").get() as any).count;
    const totalAiMessages = (db.prepare("SELECT COUNT(*) as count FROM ai_usage").get() as any).count;
    const activeSubscriptions = (db.prepare("SELECT COUNT(*) as count FROM merchant_applications WHERE status = 'approved' OR status = 'active'").get() as any).count;

    const recentApplications = db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC LIMIT 5").all();
    const recentMerchants = db.prepare(`
      SELECT s.id as store_id, s.name as store_name, s.slug, s.status as store_status, u.full_name as owner_name, u.email as owner_email, s.created_at
      FROM stores s
      JOIN users u ON u.id = s.owner_id
      WHERE s.id != 1
      ORDER BY s.id DESC LIMIT 5
    `).all();

    return res.json({
      success: true,
      metrics: {
        totalMerchants,
        activeStores,
        pendingApplications,
        suspendedStores,
        totalUsers,
        totalOrders,
        totalAiMessages,
        activeSubscriptions
      },
      recentApplications,
      recentMerchants
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/merchants
router.get('/api/master-admin/merchants', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const status = String(req.query.status || 'all').trim().toLowerCase();

    let query = `
      SELECT s.id as store_id, s.name as store_name, s.slug as store_slug, s.status as store_status, s.created_at as store_created_at,
             u.id as owner_id, u.full_name as owner_name, u.email as owner_email, u.phone as owner_phone, u.status as user_status,
             m.role as owner_role, m.status as membership_status,
             ma.plan as plan
      FROM stores s
      LEFT JOIN users u ON u.id = s.owner_id
      LEFT JOIN memberships m ON m.user_id = u.id AND m.store_id = s.id
      LEFT JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
      WHERE s.id != 1
    `;

    const params: any[] = [];

    if (status !== 'all') {
      query += ` AND (LOWER(s.status) = ? OR LOWER(m.status) = ?)`;
      params.push(status, status);
    }

    if (search) {
      query += ` AND (LOWER(s.name) LIKE ? OR LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR u.phone LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    query += ` ORDER BY s.id DESC`;

    const merchants = db.prepare(query).all(...params);
    return res.json({ success: true, merchants });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/merchants/:storeId
router.get('/api/master-admin/merchants/:storeId', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (!targetStoreId || isNaN(targetStoreId)) {
      return res.status(400).json({ success: false, error: 'GeÃƒÆ’Ã‚Â§ersiz maÃƒâ€Ã…Â¸aza ID.' });
    }

    const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
    }

    const owner = db.prepare("SELECT id, full_name, email, phone, status, created_at FROM users WHERE id = ?").get(store.owner_id) as any;
    const membership = db.prepare("SELECT * FROM memberships WHERE user_id = ? AND store_id = ?").get(store.owner_id, targetStoreId) as any;
    const application = db.prepare("SELECT * FROM merchant_applications WHERE LOWER(email) = LOWER(?)").get(owner?.email || '') as any;

    const productsCount = (db.prepare("SELECT COUNT(*) as count FROM products WHERE store_id = ?").get(targetStoreId) as any).count;
    const ordersCount = (db.prepare("SELECT COUNT(*) as count FROM orders WHERE store_id = ?").get(targetStoreId) as any).count;
    const customersCount = (db.prepare("SELECT COUNT(*) as count FROM customers WHERE store_id = ?").get(targetStoreId) as any).count;
    const campaignsCount = (db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE store_id = ?").get(targetStoreId) as any).count;
    const rewardsCount = (db.prepare("SELECT COUNT(*) as count FROM user_rewards WHERE store_id = ?").get(targetStoreId) as any).count;
    const aiUsageCount = (db.prepare("SELECT COUNT(*) as count FROM ai_usage WHERE store_id = ?").get(targetStoreId) as any).count;
    const apiKeysCount = (db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE store_id = ?").get(targetStoreId) as any).count;

    const recentProducts = db.prepare("SELECT product_code, name, price, stock FROM products WHERE store_id = ? ORDER BY id DESC LIMIT 5").all(targetStoreId);
    const recentOrders = db.prepare("SELECT id, customer_name, total_price, status, created_at FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 5").all(targetStoreId);
    const recentAuditLogs = db.prepare("SELECT id, action, entity_type, entity_id, created_at FROM audit_logs WHERE store_id = ? ORDER BY id DESC LIMIT 10").all(targetStoreId);

    AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_VIEW_MERCHANT', 'stores', String(targetStoreId));

    return res.json({
      success: true,
      detail: {
        store,
        owner,
        membership,
        application,
        metrics: {
          productsCount,
          ordersCount,
          customersCount,
          campaignsCount,
          rewardsCount,
          aiUsageCount,
          apiKeysCount
        },
        recentProducts,
        recentOrders,
        recentAuditLogs
      }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/master-admin/applications
router.get('/api/master-admin/applications', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const apps = db.prepare("SELECT id, full_name, email, store_name, plan, status, created_at FROM merchant_applications WHERE status != 'email_pending' ORDER BY id DESC").all();
    return res.json({ success: true, applications: apps });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/applications/:id/approve
router.post('/api/master-admin/applications/:id/approve', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const appId = Number(req.params.id);
    const appRow = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId) as any;
    if (!appRow) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
    }

    const verifiedUser = db.prepare('SELECT email_verified_at FROM users WHERE LOWER(email) = LOWER(?)').get(appRow.email) as any;
    if (!verifiedUser?.email_verified_at) {
      return res.status(409).json({ success: false, error: 'E-posta adresi doğrulanmadan bu başvuru onaylanamaz.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE merchant_applications SET status = \'approved\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
      db.prepare('UPDATE users SET status = \'active\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
      
      const userRow = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase()) as any;
      if (userRow) {
        db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
        db.prepare('UPDATE memberships SET status = \'active\' WHERE user_id = ?').run(userRow.id);
      }

      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_APPROVE_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
    })();

    return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla onaylandÃƒâ€Ã‚Â± ve aktifleÃƒâ€¦Ã…Â¸ti!` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/applications/:id/reject
router.post('/api/master-admin/applications/:id/reject', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const appId = Number(req.params.id);
    const appRow = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(appId) as any;
    if (!appRow) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu bulunamadÃƒâ€Ã‚Â±.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE merchant_applications SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(appId);
      db.prepare('UPDATE users SET status = \'rejected\' WHERE LOWER(email) = ?').run(appRow.email.toLowerCase());
      
      const userRow = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(appRow.email.toLowerCase()) as any;
      if (userRow) {
        db.prepare('UPDATE stores SET status = \'rejected\', updated_at = CURRENT_TIMESTAMP WHERE owner_id = ?').run(userRow.id);
        db.prepare('UPDATE memberships SET status = \'rejected\' WHERE user_id = ?').run(userRow.id);
      }

      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_REJECT_APPLICATION', 'merchant_applications', String(appId), '', appRow.email);
    })();

    return res.json({ success: true, message: `${appRow.store_name} maÃƒâ€Ã…Â¸aza baÃƒâ€¦Ã…Â¸vurusu reddedildi.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/suspend
router.post('/api/master-admin/stores/:storeId/suspend', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (targetStoreId === 1) {
      return res.status(400).json({ success: false, error: 'Master Admin maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± askÃƒâ€Ã‚Â±ya alÃƒâ€Ã‚Â±namaz.' });
    }

    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE stores SET status = \'suspended\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
      db.prepare('UPDATE memberships SET status = \'suspended\' WHERE store_id = ?').run(targetStoreId);
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_SUSPEND_STORE', 'stores', String(targetStoreId), store.status, 'suspended');
    })();

    return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± baÃƒâ€¦Ã…Â¸arÃƒâ€Ã‚Â±yla askÃƒâ€Ã‚Â±ya alÃƒâ€Ã‚Â±ndÃƒâ€Ã‚Â±.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/activate
router.post('/api/master-admin/stores/:storeId/activate', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
    }

    db.transaction(() => {
      db.prepare('UPDATE stores SET status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetStoreId);
      db.prepare('UPDATE memberships SET status = \'active\' WHERE store_id = ?').run(targetStoreId);
      db.prepare('UPDATE users SET status = \'active\' WHERE id = ?').run(store.owner_id);
      AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_ACTIVATE_STORE', 'stores', String(targetStoreId), store.status, 'active');
    })();

    return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â± yeniden aktifleÃƒâ€¦Ã…Â¸tirildi!` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/master-admin/stores/:storeId/change-plan
router.post('/api/master-admin/stores/:storeId/change-plan', AuthMiddleware.authenticate, AuthMiddleware.requireMasterAdmin, (req: AuthenticatedRequest, res) => {
  try {
    const targetStoreId = Number(req.params.storeId);
    if (targetStoreId === 1) {
      return res.status(400).json({ success: false, error: 'Master Admin store plan cannot be changed.' });
    }

    const plan = String(req.body?.plan || '').trim();
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, error: 'Yeni paket adÃƒâ€Ã‚Â± zorunludur.' });
    }

    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(targetStoreId) as any;
    if (!store) {
      return res.status(404).json({ success: false, error: 'MaÃƒâ€Ã…Â¸aza bulunamadÃƒâ€Ã‚Â±.' });
    }

    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(store.owner_id) as any;
    if (owner) {
      db.prepare('UPDATE merchant_applications SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(email) = ?').run(plan, owner.email.toLowerCase());
    }

    AuthMiddleware.logAudit(1, req.auth!.userId, 'MASTER_ADMIN_CHANGE_PLAN', 'stores', String(targetStoreId), '', String(plan));

    return res.json({ success: true, message: `${store.name} maÃƒâ€Ã…Â¸azasÃƒâ€Ã‚Â±nÃƒâ€Ã‚Â±n paketi "${plan}" olarak gÃƒÆ’Ã‚Â¼ncellendi.` });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// 3. PROTECTED MERCHANT API ENDPOINTS (Authenticated & Scoped by req.auth.storeId)
// ==========================================


export default router;
