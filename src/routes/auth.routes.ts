import { Router } from 'express';
import { db, hashPassword, needsPasswordRehash, verifyPassword } from '../database/db';
import { AuthMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

// ==========================================
// 1. PUBLIC AUTHENTICATION ROUTES
// ==========================================

// Merchant User Registration
router.post('/api/auth/register', (req, res) => {
  try {
    const { fullName, tcNo, phone, email, storeName, plan, password } = req.body || {};
    if (!fullName || !tcNo || !phone || !email || !storeName || !password) {
      return res.status(400).json({ success: false, error: 'LÃ¼tfen tÃ¼m zorunlu alanlarÄ± doldurun.' });
    }

    const cleanTcNo = String(tcNo).trim();
    if (cleanTcNo.length !== 11 || !/^\d{11}$/.test(cleanTcNo)) {
      return res.status(400).json({ success: false, error: 'T.C. Kimlik NumarasÄ± tam 11 haneli olmalÄ±dÄ±r.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanStoreName = String(storeName).trim();
    const storeSlug = cleanStoreName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `store-${Date.now()}`;

    // 1. Check existing Email
    const existingUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Bu E-Posta adresi ile zaten bir hesap veya baÅŸvuru mevcuttur.' });
    }

    // 2. Check existing TC No
    const existingTc = db.prepare('SELECT id FROM users WHERE tc_no = ?').get(cleanTcNo);
    if (existingTc) {
      return res.status(400).json({ success: false, error: 'Bu T.C. Kimlik NumarasÄ± ile zaten bir hesap mevcuttur.' });
    }

    // Hash password with PBKDF2 SHA-512 (Zero Plaintext Storage)
    const hashedPassword = hashPassword(String(password).trim());

    // Atomic transaction for Registration: users -> stores -> memberships -> merchant_applications -> audit_logs
    let resultUser: any = null;
    let resultStore: any = null;

    db.transaction(() => {
      // 1. Create User (status: 'pending')
      const userRes = db.prepare(`
        INSERT INTO users (full_name, email, phone, tc_no, password_hash, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(fullName, cleanEmail, phone, cleanTcNo, hashedPassword);
      const userId = Number(userRes.lastInsertRowid);

      // 2. Create Store (status: 'pending')
      const storeRes = db.prepare(`
        INSERT INTO stores (owner_id, name, slug, status)
        VALUES (?, ?, ?, 'pending')
      `).run(userId, cleanStoreName, storeSlug);
      const storeId = Number(storeRes.lastInsertRowid);

      // 3. Create Membership (OWNER / pending)
      db.prepare(`
        INSERT INTO memberships (user_id, store_id, role, status)
        VALUES (?, ?, 'OWNER', 'pending')
      `).run(userId, storeId);

      // 4. Create Merchant Application History (status: 'pending')
      db.prepare(`
        INSERT INTO merchant_applications (full_name, email, store_name, plan, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(fullName, cleanEmail, cleanStoreName, plan || 'Pro Store');

      // 5. Create Audit Log
      AuthMiddleware.logAudit(storeId, userId, 'REGISTER', 'users', String(userId), '', cleanEmail);

      resultUser = { id: userId, email: cleanEmail, name: fullName };
      resultStore = { id: storeId, name: cleanStoreName, slug: storeSlug };
    })();

    return res.json({
      success: true,
      message: 'MaÄŸaza baÅŸvurunuz baÅŸarÄ±yla alÄ±ndÄ±. SÃ¼per Admin onayÄ±ndan sonra giriÅŸ yapabilirsiniz.',
      user: {
        id: resultUser.id,
        email: resultUser.email,
        name: resultUser.name,
        storeId: resultStore.id,
        storeSlug: resultStore.slug,
        status: 'pending'
      }
    });
  } catch (err: any) {
    console.error('[Register Error]:', err);
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(400).json({ success: false, error: 'Bu E-Posta, T.C. Kimlik NumarasÄ± veya maÄŸaza adÄ± kullanÄ±lmaktadÄ±r.' });
    }
    return res.status(500).json({ success: false, error: 'KayÄ±t esnasÄ±nda sunucu hatasÄ± oluÅŸtu.' });
  }
});

// Merchant User Login
router.post('/api/auth/login', (req, res) => {
  const { username, email, password } = req.body || {};
  const cleanEmail = (email || username || '').trim().toLowerCase();
  const cleanPass = (password || '').trim();

  if (!cleanEmail || !cleanPass) {
    return res.status(400).json({ success: false, error: 'KullanÄ±cÄ± adÄ±/E-Posta ve ÅŸifre zorunludur.' });
  }

  // 1. Fetch user by email
  const user = db.prepare('SELECT id, full_name, email, password_hash, status FROM users WHERE LOWER(email) = ?').get(cleanEmail) as any;

  if (!user || !verifyPassword(cleanPass, user.password_hash)) {
    return res.status(401).json({ success: false, error: 'GeÃ§ersiz kullanÄ±cÄ± adÄ± veya ÅŸifre.' });
  }

  // Upgrade weak legacy PBKDF2 records only after the caller proves knowledge
  // of the password. Plain-text values never authenticate.
  if (needsPasswordRehash(user.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPass), user.id);
  }

  if (user.status === 'pending') {
    return res.status(403).json({ success: false, error: 'HesabÄ±nÄ±z henÃ¼z onay aÅŸamasÄ±ndadÄ±r. SÃ¼per Admin onayÄ±ndan sonra giriÅŸ yapabilirsiniz.' });
  }

  if (user.status !== 'active') {
    return res.status(403).json({ success: false, error: 'HesabÄ±nÄ±z pasif durumdadÄ±r.' });
  }

  // 2. Fetch active memberships
  const memberships = db.prepare(`
    SELECT m.store_id, m.role, s.name as store_name, s.slug as store_slug, s.status as store_status
    FROM memberships m
    JOIN stores s ON s.id = m.store_id
    WHERE m.user_id = ? AND m.status = 'active' AND s.status = 'active'
    ORDER BY m.id ASC
  `).all(user.id) as any[];

  if (!memberships || memberships.length === 0) {
    return res.status(403).json({ success: false, error: 'Aktif veya onaylanmÄ±ÅŸ bir maÄŸaza Ã¼yeliÄŸiniz bulunmamaktadÄ±r.' });
  }

  // Pick target store (or requested storeId if valid)
  const reqStoreId = Number(req.body?.storeId);
  let activeMem = memberships[0];
  if (reqStoreId) {
    const found = memberships.find(m => m.store_id === reqStoreId);
    if (found) activeMem = found;
  }

  const token = AuthMiddleware.generateToken({
    userId: user.id,
    storeId: activeMem.store_id,
    role: activeMem.role,
    email: user.email
  });

  AuthMiddleware.logAudit(activeMem.store_id, user.id, 'LOGIN', 'users', String(user.id), '', user.email);

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.full_name,
      storeId: activeMem.store_id,
      storeName: activeMem.store_name,
      storeSlug: activeMem.store_slug,
      role: activeMem.role
    }
  });
});

// Verify Auth Token Endpoint
router.get('/api/auth/verify', AuthMiddleware.authenticate, (req: AuthenticatedRequest, res) => {
  return res.json({ success: true, valid: true, user: req.auth });
});


export default router;
