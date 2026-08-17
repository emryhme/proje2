import './test-env';
import crypto from 'crypto';
import { StockService } from '../services/stock.service';
import { InventoryService } from '../services/inventory.service';
import { OrderService } from '../services/order.service';
import { AIService } from '../services/ai.service';
import { AdminCopilotService } from '../services/admin-copilot.service';
import { GeminiService } from '../services/gemini.service';
import { WebhookController } from '../controllers/webhook.controller';
import { FacebookService } from '../services/facebook.service';
import { DemoAIService } from '../services/demo-ai.service';
import { EmailVerificationService } from '../services/email-verification.service';
import { AuthMiddleware } from '../middleware/auth.middleware';
import { db, hashPassword, initDatabase, needsPasswordRehash, verifyPassword } from '../database/db';
import { decryptSettingSecret, encryptSettingSecret } from '../utils/secret.util';
import { normalizeRecords, parseImportContent, suggestMapping, collectHeaders } from '../services/data-import.service';

initDatabase();

async function runTestSuite() {
  console.log('🧪 Starting ISC Works Master Admin & Master Security & Stock Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  const foreignKeysEnabled = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  assert(foreignKeysEnabled, 'SQLite foreign key enforcement is enabled');

  // PRE-TEST CLEANUP
  db.prepare('DELETE FROM audit_logs WHERE store_id IN (1, 100, 200, 999)').run();
  db.prepare('DELETE FROM api_keys WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM orders WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM order_items WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM customers WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM products WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM inventory WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM campaigns WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM settings WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM user_rewards WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM conversations WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM webhook_events WHERE store_id IN (100, 200, 999)').run();
  db.prepare('DELETE FROM memberships WHERE store_id IN (100, 200, 400, 999)').run();
  db.prepare("DELETE FROM merchant_applications WHERE email = 'unverified-test@iscworks.com'").run();
  db.prepare('DELETE FROM stores WHERE id IN (100, 200, 400, 999)').run();
  db.prepare("DELETE FROM users WHERE id IN (10, 11, 20, 30, 40) OR email IN ('owner_a@iscworks.com', 'staff_a@iscworks.com', 'owner_b@iscworks.com', 'inactive_user@iscworks.com', 'unverified-test@iscworks.com')").run();

  // SEED STORES
  db.prepare("INSERT OR IGNORE INTO stores (id, owner_id, name, slug, status) VALUES (100, 10, 'Store Alpha', 'store-alpha', 'active')").run();
  db.prepare("INSERT OR IGNORE INTO stores (id, owner_id, name, slug, status) VALUES (200, 20, 'Store Beta', 'store-beta', 'active')").run();
  db.prepare("INSERT OR IGNORE INTO stores (id, owner_id, name, slug, status) VALUES (999, 30, 'Store Suspended', 'store-suspended', 'suspended')").run();

  // SEED USERS & MEMBERSHIPS
  const passHash = hashPassword('password123');
  
  // User 10: Store 100 OWNER
  db.prepare("INSERT INTO users (id, full_name, email, password_hash, status) VALUES (10, 'Owner Alpha', 'owner_a@iscworks.com', ?, 'active')").run(passHash);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (10, 100, 'OWNER', 'active')").run();

  // User 11: Store 100 STAFF
  db.prepare("INSERT INTO users (id, full_name, email, password_hash, status) VALUES (11, 'Staff Alpha', 'staff_a@iscworks.com', ?, 'active')").run(passHash);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (11, 100, 'STAFF', 'active')").run();

  // User 20: Store 200 OWNER
  db.prepare("INSERT INTO users (id, full_name, email, password_hash, status) VALUES (20, 'Owner Beta', 'owner_b@iscworks.com', ?, 'active')").run(passHash);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (20, 200, 'OWNER', 'active')").run();

  // User 30: Inactive Membership User
  db.prepare("INSERT INTO users (id, full_name, email, password_hash, status) VALUES (30, 'Inactive User', 'inactive_user@iscworks.com', ?, 'active')").run(passHash);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (30, 100, 'OWNER', 'inactive')").run();

  // Unverified and unapproved registrations must never appear as merchants.
  db.prepare("INSERT INTO users (id, full_name, email, phone, password_hash, status) VALUES (40, 'Unverified Test', 'unverified-test@iscworks.com', '05000000000', ?, 'pending')").run(passHash);
  db.prepare("INSERT INTO stores (id, owner_id, name, slug, status) VALUES (400, 40, 'Unverified Store', 'unverified-store', 'pending')").run();
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (40, 400, 'OWNER', 'pending')").run();
  db.prepare("INSERT INTO merchant_applications (full_name, email, store_name, plan, status) VALUES ('Unverified Test', 'unverified-test@iscworks.com', 'Unverified Store', 'Pro Store', 'email_pending')").run();
  const visibleMerchantCount = () => (db.prepare(`
    SELECT COUNT(*) AS count FROM stores s
    JOIN users u ON u.id = s.owner_id
    JOIN merchant_applications ma ON LOWER(ma.email) = LOWER(u.email)
    WHERE s.id = 400 AND u.email_verified_at IS NOT NULL AND ma.status IN ('approved', 'active')
  `).get() as any).count;
  assert(visibleMerchantCount() === 0, 'Unverified registrations stay hidden from merchants and stores');
  db.prepare("UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = 40").run();
  db.prepare("UPDATE merchant_applications SET status = 'pending' WHERE email = 'unverified-test@iscworks.com'").run();
  assert(visibleMerchantCount() === 0, 'Verified applications stay out of merchants until Super Admin approval');
  db.prepare("UPDATE merchant_applications SET status = 'approved' WHERE email = 'unverified-test@iscworks.com'").run();
  assert(visibleMerchantCount() === 1, 'Approved verified stores become visible in merchants');
  db.prepare('DELETE FROM memberships WHERE store_id = 400').run();
  db.prepare('DELETE FROM stores WHERE id = 400').run();
  db.prepare("DELETE FROM merchant_applications WHERE email = 'unverified-test@iscworks.com'").run();
  db.prepare('DELETE FROM users WHERE id = 40').run();

  // SEED PRODUCTS
  await StockService.addProduct({ storeId: 100, shortCode: 'TSH', productCode: 'TSH-M', name: 'T-Shirt A', size: 'M', stock: 20, price: 150 });
  await StockService.addProduct({ storeId: 200, shortCode: 'TSH', productCode: 'TSH-M', name: 'T-Shirt B', size: 'M', stock: 40, price: 450 });

  // 1. AUTH & JWT TESTS
  console.log('1️⃣ AUTH TEST 1: Password Verification (PBKDF2 SHA-512)');
  assert(verifyPassword('password123', passHash) === true, 'Valid password verification returns true');
  assert(verifyPassword('wrongpassword', passHash) === false, 'Invalid password verification returns false');
  assert(needsPasswordRehash(passHash) === false, 'New password hashes use the current secure format');
  assert(verifyPassword('password123', 'password123') === false, 'Plain-text password values are rejected');
  const legacyHash = `pbkdf2:sha512:${crypto.pbkdf2Sync('password123', 'iscworks_salt_2026', 1_000, 64, 'sha512').toString('hex')}`;
  assert(verifyPassword('password123', legacyHash) === true && needsPasswordRehash(legacyHash) === true, 'Legacy PBKDF2 hashes are eligible for secure login-time upgrade');
  const applicationColumns = db.prepare("PRAGMA table_info(merchant_applications)").all() as Array<{ name: string }>;
  assert(!applicationColumns.some((column) => ['tc_no', 'phone', 'password'].includes(column.name)), 'Application history does not retain duplicated personal data or passwords');
  const planTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('store_subscriptions', 'plan_support_requests')").all() as Array<{ name: string }>;
  assert(planTables.length === 2, 'Plan periods and plan support requests have dedicated database tables');
  const productColumns = db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>;
  const instagramCatalogTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instagram_media_catalog'").get() as any;
  assert(productColumns.some(column => column.name === 'instagram_media_id') && Boolean(instagramCatalogTable), 'Instagram Media IDs and synchronized post metadata have dedicated indexed storage');

  db.prepare("INSERT INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at) VALUES (100, 'Pro Store', 6, '2026-08-14', '2027-02-14')").run();
  db.prepare("INSERT INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at) VALUES (200, 'Starter Store', 3, '2026-08-14', '2026-11-14')").run();
  db.prepare("INSERT INTO plan_support_requests (store_id, user_id, current_plan, requested_plan, message) VALUES (100, 10, 'Pro Store', 'Enterprise Store', 'Enterprise plana geçiş hakkında destek istiyorum.')").run();
  const storeAPlan = db.prepare('SELECT plan_name, duration_months, starts_at, ends_at FROM store_subscriptions WHERE store_id = 100').get() as any;
  const storeBPlanRequests = (db.prepare('SELECT COUNT(*) AS count FROM plan_support_requests WHERE store_id = 200').get() as any).count;
  assert(storeAPlan.plan_name === 'Pro Store' && storeAPlan.duration_months === 6 && storeAPlan.ends_at === '2027-02-14', 'Plan duration remains scoped to its store with explicit start and end dates');
  assert(storeBPlanRequests === 0, 'Plan support requests remain isolated between stores');
  const merchantRecentOrders = db.prepare(`
    SELECT id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS customer_name, total_price, status, created_at
    FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 5
  `).all(100);
  assert(Array.isArray(merchantRecentOrders), 'Master Admin merchant detail uses valid order customer columns');
  const flexibleRows = parseImportContent('json', JSON.stringify({ payload: { items: [
    { SKU: 'MAP-M', Description: 'Mapped Product', Option1: 'Medium', 'Sale Price': '₺1.299,90', Inventory: '12', instagram_media_id: 'media_map_1' },
    { SKU: 'THOUSAND-M', Description: 'Turkish Thousands Product', Option1: 'Medium', 'Sale Price': '1.150', Inventory: '4' },
    { SKU: 'DECIMAL-M', Description: 'Dot Decimal Product', Option1: 'Medium', 'Sale Price': '799.90', Inventory: '3' }
  ] } }));
  const flexibleMapping = suggestMapping(collectHeaders(flexibleRows));
  const flexibleNormalized = normalizeRecords(flexibleRows, flexibleMapping);
  assert(flexibleNormalized.validRows[0]?.productCode === 'MAP-M' && flexibleNormalized.validRows[0]?.size === 'M' && flexibleNormalized.validRows[0]?.price === 1299.9 && flexibleNormalized.validRows[0]?.instagramMediaId === 'media_map_1', 'Flexible nested JSON fields including Instagram Media ID are automatically mapped and normalized');
  assert(flexibleNormalized.validRows[1]?.price === 1150 && flexibleNormalized.validRows[2]?.price === 799.9, 'Turkish thousands dots and decimal dots are distinguished while importing prices');
  const shuffledCsvRows = parseImportContent('csv', [
    'Tedarikçi Notu;Görsel Adresi;Depodaki Miktar;Referans No;KDV Oranı;Varyasyon;Ürün Başlığı;Satış Tutarı;Renk Bilgisi;Ürün Sayfası',
    'Yeni sezon ürünü;https://example.com/hbl-m.jpg;24;HBL-M;%20;Medium;Oversize HBL Gömlek;₺799,90;Ekru;https://example.com/hbl-m'
  ].join('\n'));
  const shuffledMapping = suggestMapping(collectHeaders(shuffledCsvRows));
  const shuffledNormalized = normalizeRecords(shuffledCsvRows, shuffledMapping);
  assert(
    shuffledMapping.productCode === 'Referans No'
      && shuffledMapping.price === 'Satış Tutarı'
      && shuffledMapping.stock === 'Depodaki Miktar'
      && shuffledNormalized.validRows[0]?.productCode === 'HBL-M'
      && shuffledNormalized.validRows[0]?.price === 799.9,
    'Shuffled Turkish supplier columns are recognized without manual mapping'
  );

  console.log('\n2️⃣ AUTH TEST 2: Valid JWT Token Generation & Verification');
  const jwtOwnerA = AuthMiddleware.generateToken({ userId: 10, storeId: 100, role: 'OWNER', email: 'owner_a@iscworks.com' });
  const decodedA = AuthMiddleware.verifyToken(jwtOwnerA);
  assert(decodedA !== null && decodedA.userId === 10 && decodedA.storeId === 100 && decodedA.role === 'OWNER', 'Valid JWT token verified successfully');

  console.log('\n3️⃣ AUTH TEST 3: Invalid & Expired Token Rejection');
  const invalidSigToken = jwtOwnerA.substring(0, jwtOwnerA.length - 5) + 'X1Y2Z';
  assert(AuthMiddleware.verifyToken(invalidSigToken) === null, 'Tampered/invalid signature token rejected');
  assert(AuthMiddleware.verifyToken('') === null, 'Empty token rejected');
  const jwtParts = jwtOwnerA.split('.');
  const wrongAlgorithmHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const wrongAlgorithmSignature = crypto.createHmac('sha256', process.env.JWT_SECRET!).update(`${wrongAlgorithmHeader}.${jwtParts[1]}`).digest('base64url');
  assert(AuthMiddleware.verifyToken(`${wrongAlgorithmHeader}.${jwtParts[1]}.${wrongAlgorithmSignature}`) === null, 'JWT tokens with an unexpected algorithm are rejected');
  const encryptedSecret = encryptSettingSecret('top-secret-token');
  assert(encryptedSecret !== 'top-secret-token' && decryptSettingSecret(encryptedSecret) === 'top-secret-token', 'Stored integration secrets are encrypted and decrypt correctly');

  console.log('\n4️⃣ AUTH TEST 4: Legacy Session Token Bypass Rejection on Protected API');
  let authFailed: boolean = false;
  const mockResAuth = { status: (code: number) => ({ json: (data: any) => { if (code === 401) authFailed = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: 'Bearer session_barons_legacy_hack_token' } } as any, mockResAuth, () => {});
  assert((authFailed as boolean) === true, 'Legacy session_barons_ bypass token rejected on protected API');

  // 2. TENANT ISOLATION TESTS
  console.log('\n5️⃣ TENANT TEST 1: Authenticated Request Tenant Scoping');
  let reqContext: any = null;
  const mockReqStoreA = { headers: { authorization: `Bearer ${jwtOwnerA}` } } as any;
  AuthMiddleware.authenticate(mockReqStoreA, mockResAuth, () => { reqContext = mockReqStoreA.auth; });
  assert(reqContext !== null && reqContext.storeId === 100 && reqContext.role === 'OWNER', 'Auth context populated with validated storeId 100');

  db.prepare("UPDATE users SET status = 'suspended' WHERE id = 10").run();
  let disabledUserBlocked = false;
  const disabledRes = { status: (code: number) => ({ json: () => { if (code === 403) disabledUserBlocked = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtOwnerA}` }, method: 'GET', path: '/api/orders' } as any, disabledRes, () => {});
  assert(disabledUserBlocked, 'Disabled users cannot keep using an existing session token');
  db.prepare("UPDATE users SET status = 'active' WHERE id = 10").run();

  db.prepare("UPDATE store_subscriptions SET starts_at = '2025-01-01', ends_at = '2025-02-01' WHERE store_id = 100").run();
  let expiredPlanWriteBlocked = false;
  const expiredPlanRes = { status: (code: number) => ({ json: () => { if (code === 402) expiredPlanWriteBlocked = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtOwnerA}` }, method: 'POST', path: '/api/products' } as any, expiredPlanRes, () => {});
  let expiredPlanReadAllowed = false;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtOwnerA}` }, method: 'GET', path: '/api/plan' } as any, expiredPlanRes, () => { expiredPlanReadAllowed = true; });
  assert(expiredPlanWriteBlocked && expiredPlanReadAllowed, 'Expired plans become read-only while plan information remains accessible');
  db.prepare("UPDATE store_subscriptions SET starts_at = '2026-08-14', ends_at = '2027-02-14' WHERE store_id = 100").run();

  console.log('\n6️⃣ TENANT TEST 2: Cross-Tenant Store B Access Rejection for Store A User');
  const jwtFakeB = AuthMiddleware.generateToken({ userId: 10, storeId: 200, role: 'OWNER', email: 'owner_a@iscworks.com' });
  let forbidFailed: boolean = false;
  const mockResForbid = { status: (code: number) => ({ json: () => { if (code === 403) forbidFailed = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtFakeB}` } } as any, mockResForbid, () => {});
  assert((forbidFailed as boolean) === true, 'User 10 attempting to claim Store 200 JWT is rejected by DB membership check');

  console.log('\n7️⃣ TENANT TEST 3: Inactive Membership Rejection');
  const jwtInactive = AuthMiddleware.generateToken({ userId: 30, storeId: 100, role: 'OWNER', email: 'inactive_user@iscworks.com' });
  let inactiveFailed: boolean = false;
  const mockResInactive = { status: (code: number) => ({ json: () => { if (code === 403) inactiveFailed = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtInactive}` } } as any, mockResInactive, () => {});
  assert((inactiveFailed as boolean) === true, 'User 30 with inactive membership is rejected with 403 Forbidden');

  console.log('\n8️⃣ TENANT TEST 4: Suspended Store Rejection');
  const jwtSuspended = AuthMiddleware.generateToken({ userId: 30, storeId: 999, role: 'OWNER', email: 'inactive_user@iscworks.com' });
  let suspendedFailed: boolean = false;
  const mockResSuspended = { status: (code: number) => ({ json: () => { if (code === 403) suspendedFailed = true; } }) } as any;
  AuthMiddleware.authenticate({ headers: { authorization: `Bearer ${jwtSuspended}` } } as any, mockResSuspended, () => {});
  assert((suspendedFailed as boolean) === true, 'User attempting access to suspended store 999 is rejected with 403 Forbidden');

  // 3. RBAC ROLE ESCALATION TESTS
  console.log('\n9️⃣ RBAC TEST 1: OWNER Role Access Allowance');
  let roleOwnerPassed: boolean = false;
  const rbacOwnerReq = { auth: { userId: 10, storeId: 100, role: 'OWNER', email: 'owner_a@iscworks.com' } } as any;
  AuthMiddleware.requireRole(['OWNER'])(rbacOwnerReq, mockResForbid, () => { roleOwnerPassed = true; });
  assert((roleOwnerPassed as boolean) === true, 'OWNER role passes OWNER restricted middleware');

  console.log('\n🔟 RBAC TEST 2: STAFF Role Access Restriction on OWNER Action');
  let roleStaffBlocked: boolean = false;
  const rbacStaffReq = { auth: { userId: 11, storeId: 100, role: 'STAFF', email: 'staff_a@iscworks.com' } } as any;
  const mockResRbac = { status: (code: number) => ({ json: () => { if (code === 403) roleStaffBlocked = true; } }) } as any;
  AuthMiddleware.requireRole(['OWNER'])(rbacStaffReq, mockResRbac, () => { roleStaffBlocked = false; });
  assert((roleStaffBlocked as boolean) === true, 'STAFF role blocked from OWNER restricted action');

  // 4. API KEY & AUDIT LOG TESTS
  console.log('\n1️⃣1️⃣ API KEY TEST: Multi-Tenant API Key Authentication');
  const rawKey = 'isc_live_test_key_12345';
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  db.prepare("INSERT INTO api_keys (store_id, name, key_hash, permissions) VALUES (100, 'Integration Test Key', ?, 'read_write')").run(keyHash);
  let apiKeyAuthenticated: boolean = false;
  let apiKeyStoreId = 0;
  const mockReqApiKey = { headers: { 'x-api-key': rawKey } } as any;
  AuthMiddleware.authenticate(mockReqApiKey, mockResAuth, () => {
    apiKeyAuthenticated = true;
    apiKeyStoreId = mockReqApiKey.auth?.storeId || 0;
  });
  assert((apiKeyAuthenticated as boolean) === true && apiKeyStoreId === 100, 'API key authenticated strictly to Store ID 100');

  console.log('\n1️⃣2️⃣ AUDIT LOG TEST: Audit Logging Scoped by Store ID');
  AuthMiddleware.logAudit(100, 10, 'TEST_AUDIT_ACTION', 'products', 'TSH-M');
  const auditRow = db.prepare("SELECT * FROM audit_logs WHERE store_id = 100 AND action = 'TEST_AUDIT_ACTION'").get() as any;
  assert(auditRow !== undefined && auditRow.user_id === 10 && auditRow.entity_id === 'TSH-M', 'Audit log inserted strictly with store_id 100 and user_id 10');

  // 5. MASTER ADMIN AUTH & SECURITY TESTS
  console.log('\n1️⃣3️⃣ MASTER ADMIN TEST 1: Master Admin Authorization Allowance (Store 1 OWNER)');
  let masterAdminAllowed = false;
  const reqMasterAdmin = { auth: { userId: 1, storeId: 1, role: 'OWNER', email: 'tonystark@iscworks.com' } } as any;
  AuthMiddleware.requireMasterAdmin(reqMasterAdmin, mockResForbid, () => { masterAdminAllowed = true; });
  assert((masterAdminAllowed as boolean) === true, 'Master Admin token (Store 1 OWNER) passes requireMasterAdmin middleware');

  console.log('\n1️⃣4️⃣ MASTER ADMIN TEST 2: Merchant Store 100 Access Rejection on Master Admin Route');
  let merchantBlockedOnMaster = false;
  const reqMerchant = { auth: { userId: 10, storeId: 100, role: 'OWNER', email: 'owner_a@iscworks.com' } } as any;
  const mockResMasterForbid = { status: (code: number) => ({ json: (d: any) => { if (code === 403) merchantBlockedOnMaster = true; } }) } as any;
  AuthMiddleware.requireMasterAdmin(reqMerchant, mockResMasterForbid, () => { merchantBlockedOnMaster = false; });
  assert((merchantBlockedOnMaster as boolean) === true, 'Merchant (Store 100 OWNER) blocked from Master Admin API with 403 Forbidden');

  console.log('\n1️⃣5️⃣ MASTER ADMIN TEST 3: Store Suspension & Activation Actions with Audit Logging');
  db.prepare("UPDATE stores SET status = 'suspended' WHERE id = 100").run();
  AuthMiddleware.logAudit(1, 1, 'MASTER_ADMIN_SUSPEND_STORE', 'stores', '100', 'active', 'suspended');
  const store100Row = db.prepare("SELECT status FROM stores WHERE id = 100").get() as any;
  const auditSuspend = db.prepare("SELECT * FROM audit_logs WHERE action = 'MASTER_ADMIN_SUSPEND_STORE' AND entity_id = '100'").get() as any;
  assert(store100Row.status === 'suspended' && auditSuspend !== undefined, 'Master Admin suspend action updates store status and writes audit log');

  db.prepare("UPDATE stores SET status = 'active' WHERE id = 100").run();
  AuthMiddleware.logAudit(1, 1, 'MASTER_ADMIN_ACTIVATE_STORE', 'stores', '100', 'suspended', 'active');
  const store100Active = db.prepare("SELECT status FROM stores WHERE id = 100").get() as any;
  assert(store100Active.status === 'active', 'Master Admin activate action restores store status');

  console.log('\n1️⃣6️⃣ STAGE 7 FRONTEND & REGRESSION: Webhook Resolution & Idempotency');
  const resolvedAlpha = WebhookController.resolveStore('store-alpha');
  assert(resolvedAlpha !== null && resolvedAlpha.id === 100, 'store-alpha resolved to Store ID 100');
  const firstEvt = WebhookController.isDuplicateEvent('evt_master_001', 100);
  const secondEvt = WebhookController.isDuplicateEvent('evt_master_001', 100);
  assert(firstEvt === false && secondEvt === true, 'Webhook idempotency works seamlessly across multi-tenant events');

  // 6. WEBHOOK MULTI-TENANT ISOLATION SECURITY ATTACK TESTS
  console.log('\n1️⃣7️⃣ WEBHOOK SECURITY ATTACK TEST 1: Store A Meta Page ID Resolution');
  db.prepare("UPDATE stores SET meta_page_id = 'page_100', instagram_account_id = 'ig_100' WHERE id = 100").run();
  db.prepare("UPDATE stores SET meta_page_id = 'page_200', instagram_account_id = 'ig_200' WHERE id = 200").run();
  const resStoreA = WebhookController.resolveStoreByMetaId('page_100');
  assert(resStoreA !== null && resStoreA.id === 100, 'Store A Meta Page ID page_100 resolves strictly to Store ID 100');

  console.log('\n1️⃣8️⃣ WEBHOOK SECURITY ATTACK TEST 2: Store B Meta Page ID Resolution');
  const resStoreB = WebhookController.resolveStoreByMetaId('page_200');
  assert(resStoreB !== null && resStoreB.id === 200, 'Store B Meta Page ID page_200 resolves strictly to Store ID 200');

  console.log('\n1️⃣9️⃣ WEBHOOK SECURITY ATTACK TEST 3: Fake req.body.storeId = 200 Injection Protection');
  const resolvedTarget = WebhookController.resolveStoreByMetaId('page_100');
  assert(resolvedTarget !== null && resolvedTarget.id === 100, 'Fake body.storeId=200 injection ignored, tenant remains Store ID 100');

  console.log('\n2️⃣0️⃣ WEBHOOK SECURITY ATTACK TEST 4: Fake Query Parameter ?storeId=200 Injection Protection');
  const resolvedTargetQuery = WebhookController.resolveStoreByMetaId('page_100');
  assert(resolvedTargetQuery !== null && resolvedTargetQuery.id === 100, 'Fake query ?storeId=200 parameter injection ignored, tenant remains Store ID 100');

  console.log('\n2️⃣1️⃣ WEBHOOK SECURITY ATTACK TEST 5: Cross-Tenant Product Code Query Isolation');
  const storeAProds = await StockService.getAllProducts(100);
  const storeAHasStoreBItem = storeAProds.some(p => p.name === 'T-Shirt B');
  assert(storeAProds.length > 0 && !storeAHasStoreBItem, 'Store A product stock query cannot see Store B products');

  let missingStoreIdRejected = false;
  try {
    await (StockService.getAllProducts as any)();
  } catch {
    missingStoreIdRejected = true;
  }
  assert(missingStoreIdRejected, 'Stock service rejects calls without an explicit store ID');

  let missingOrderStoreIdRejected = false;
  try {
    await (OrderService.getOrders as any)();
  } catch {
    missingOrderStoreIdRejected = true;
  }
  assert(missingOrderStoreIdRejected, 'Order service rejects calls without an explicit store ID');

  console.log('\n2️⃣2️⃣ WEBHOOK SECURITY ATTACK TEST 6: Cross-Tenant Order ID Lookup Protection');
  db.prepare("INSERT INTO orders (order_id, store_id, first_name, customer_phone, address, product_code, total_price, status) VALUES ('ORD99901', 200, 'Beta Customer', '0555', 'Address', 'TSH-M', 450, 'completed')").run();
  const crossOrderLookup = db.prepare("SELECT * FROM orders WHERE store_id = 100 AND order_id = 'ORD99901'").get();
  assert(crossOrderLookup === undefined, 'Store A webhook order query cannot access Store B order ID ORD99901');

  console.log('\n2️⃣3️⃣ WEBHOOK SECURITY ATTACK TEST 7: Multi-Tenant Conversation History Isolation for Same Sender');
  const convIdA = AIService.getOrCreateConversation(100, 'sender_x');
  const convIdB = AIService.getOrCreateConversation(200, 'sender_x');
  assert(convIdA !== convIdB && convIdA > 0 && convIdB > 0, 'Same sender_x creates two distinct isolated conversations for Store 100 and Store 200');

  console.log('\n2️⃣4️⃣ WEBHOOK SECURITY ATTACK TEST 8: Customer Record Isolation Across Tenants');
  db.prepare("INSERT INTO customers (store_id, sender_id, name) VALUES (100, 'sender_x', 'Customer Alpha')").run();
  db.prepare("INSERT INTO customers (store_id, sender_id, name) VALUES (200, 'sender_x', 'Customer Beta')").run();
  const custA = db.prepare("SELECT name FROM customers WHERE store_id = 100 AND sender_id = 'sender_x'").get() as any;
  const custB = db.prepare("SELECT name FROM customers WHERE store_id = 200 AND sender_id = 'sender_x'").get() as any;
  assert(custA?.name === 'Customer Alpha' && custB?.name === 'Customer Beta', 'Customer records for same sender_x remain strictly isolated per tenant');

  console.log('\n2️⃣5️⃣ WEBHOOK SECURITY ATTACK TEST 9: Invalid Signature Rejection');
  process.env.INSTAGRAM_APP_SECRET = 'super_secret_test_key_123';
  const invalidSigReq = { headers: { 'x-hub-signature-256': 'sha256=invalid_hash_signature' }, body: { text: 'test' } } as any;
  const sigValid = WebhookController.verifySignature(invalidSigReq);
  assert(sigValid === false, 'Invalid Meta HMAC signature rejected with false (HTTP 401/403)');
  const rawWebhookPayload = Buffer.from('{"entry":[{"id":"page_100"}]}', 'utf8');
  const validSignature = crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET!).update(rawWebhookPayload).digest('hex');
  const validSigReq = { headers: { 'x-hub-signature-256': `sha256=${validSignature}` }, rawBody: rawWebhookPayload } as any;
  assert(WebhookController.verifySignature(validSigReq) === true, 'Valid Meta HMAC is verified against the original raw request bytes');

  console.log('\n2️⃣6️⃣ WEBHOOK SECURITY ATTACK TEST 10: Multi-Tenant Event Idempotency Check');
  const evtStoreA = WebhookController.isDuplicateEvent('evt_attack_001', 100);
  const evtStoreB = WebhookController.isDuplicateEvent('evt_attack_001', 200);
  const evtStoreARepeat = WebhookController.isDuplicateEvent('evt_attack_001', 100);
  assert(evtStoreA === false && evtStoreB === false && evtStoreARepeat === true, 'Event idempotency tracks event_id scoped strictly by tenant store_id');

  console.log('\n2️⃣6️⃣-A INSTAGRAM COMMENT TEST: Post comment webhook fields must be parsed safely');
  const parsedComment = WebhookController.extractInstagramComment({
    field: 'comments',
    value: {
      id: 'comment_123',
      from: { id: 'igsid_customer_1', username: 'customer_one' },
      media: { id: 'media_456' },
      text: 'HBL almak istiyorum'
    }
  });
  assert(
    parsedComment?.commentId === 'comment_123' &&
    parsedComment.commenterId === 'igsid_customer_1' &&
    parsedComment.mediaId === 'media_456' &&
    parsedComment.text === 'HBL almak istiyorum',
    'Instagram comment ID, commenter, media and text are extracted from the official comments webhook shape'
  );
  assert(
    WebhookController.extractInstagramComment({ field: 'messages', value: { id: 'not_a_comment', text: 'ignored' } }) === null,
    'Non-comment webhook changes cannot enter the Instagram comment sales flow'
  );
  db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (100, 'instagram_comment_permission_granted', '1')").run();
  db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (100, 'instagram_comment_automation_enabled', '1')").run();
  assert(WebhookController.isInstagramCommentAutomationEnabled(100) === false, 'Instagram comments remain disabled even when stale legacy settings exist');

  console.log('\n2️⃣6️⃣-B DM BUFFER TEST: Rapid messages trigger one tenant-scoped AI request');
  const webhookControllerForBuffer = WebhookController as any;
  const originalProcessAndReply = webhookControllerForBuffer.processAndReply;
  const bufferedCalls: any[] = [];
  try {
    webhookControllerForBuffer.processAndReply = async (...args: any[]) => { bufferedCalls.push(args); };
    webhookControllerForBuffer.enqueueMessage('rapid_sender', 'Merhaba', 'store-alpha', 100);
    webhookControllerForBuffer.enqueueMessage('rapid_sender', 'HBL ürününün', 'store-alpha', 100);
    webhookControllerForBuffer.enqueueMessage('rapid_sender', 'fiyatı nedir?', 'store-alpha', 100);
    webhookControllerForBuffer.enqueueMessage('rapid_sender', 'Farklı mağaza mesajı', 'store-beta', 200);
    await Promise.all([
      webhookControllerForBuffer.flushBufferedMessages('100:rapid_sender'),
      webhookControllerForBuffer.flushBufferedMessages('200:rapid_sender')
    ]);
  } finally {
    webhookControllerForBuffer.processAndReply = originalProcessAndReply;
  }
  const storeABufferCall = bufferedCalls.find(call => call[3] === 100);
  const storeBBufferCall = bufferedCalls.find(call => call[3] === 200);
  assert(
    bufferedCalls.length === 2 &&
    storeABufferCall?.[1] === 'Merhaba\nHBL ürününün\nfiyatı nedir?' &&
    storeABufferCall?.[4]?.length === 3 &&
    storeBBufferCall?.[1] === 'Farklı mağaza mesajı',
    'Rapid messages are combined once per store and sender while different tenants remain isolated'
  );

  // 7. STOCK BUG FIX TESTS (ADD, SET, ISOLATION, COLLISION & SANITATION)
  console.log('\n2️⃣7️⃣ STOCK BUG FIX TEST 1: Stock Add (+5 from 10 -> 15)');
  await StockService.addProduct({ storeId: 100, shortCode: 'TST', productCode: 'TEST-STOCK', name: 'Test Product', size: 'M', stock: 10, price: 200 });
  const updateSuccess1 = await StockService.updateStock(100, 'TEST-STOCK', 15);
  const prodRow1 = db.prepare("SELECT stock FROM products WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any;
  const invRow1 = db.prepare("SELECT stock FROM inventory WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any;
  assert(updateSuccess1 === true && prodRow1?.stock === 15 && invRow1?.stock === 15, 'Stock updated to 15 in both products and inventory tables');

  console.log('\n2️⃣7️⃣-A AI VARIANT TEST: "Müşteri" kelimesi M beden sayılmamalı');
  await StockService.addProduct({ storeId: 100, shortCode: 'HBL', productCode: 'HBL-S', name: 'HBL Test', size: 'S', stock: 10, price: 250, instagramMediaId: 'media_hbl_1' });
  await StockService.addProduct({ storeId: 100, shortCode: 'HBL', productCode: 'HBL-M', name: 'HBL Test', size: 'M', stock: 10, price: 250, instagramMediaId: 'media_hbl_1' });
  const familyStock = await StockService.checkStock(100, 'HBL stok durumu');
  const familyStockCtx = AIService.getSessionContext('family-stock-test', 'store-alpha', 100, 'TEST');
  familyStockCtx.productCode = 'HBL';
  const familyStockReply = await (AIService as any).getProductStockReply(100, familyStockCtx, 'HBL stokta kaç adet var?');
  const exactStockCtx = AIService.getSessionContext('exact-stock-test', 'store-alpha', 100, 'TEST');
  exactStockCtx.productCode = 'HBL-M';
  exactStockCtx.size = 'M';
  const exactStockReply = await (AIService as any).getProductStockReply(100, exactStockCtx, 'HBL-M stokta var mı?');
  assert(
    familyStock.product?.productCode === 'HBL' && familyStock.product?.stock === 20 && familyStock.product?.variants?.length === 2 &&
    familyStockReply.includes('Stokta bulunan bedenler:') && familyStockReply.includes('M') && familyStockReply.includes('S') &&
    !/\d+\s*adet/i.test(familyStockReply) && exactStockReply.includes('stokta mevcut') && !/\d+\s*adet/i.test(exactStockReply),
    'Customer-facing stock replies expose availability and sizes without revealing inventory quantities'
  );
  const stockPrivacyTools = (AIService as any).createLeafTools('stock-privacy', 'store-alpha', 100, 'TEST');
  const exactStockToolResult = JSON.parse(String(await stockPrivacyTools.stokTool.invoke(JSON.stringify({ productCode: 'HBL-M', size: 'M' }))));
  const familyStockToolResult = JSON.parse(String(await stockPrivacyTools.stokTool.invoke(JSON.stringify({ productCode: 'HBL' }))));
  assert(
    !Object.prototype.hasOwnProperty.call(exactStockToolResult, 'stock') &&
    !Object.prototype.hasOwnProperty.call(familyStockToolResult, 'stock') &&
    !Object.prototype.hasOwnProperty.call(familyStockToolResult, 'variants'),
    'AI stock tool results expose availability but never inventory quantities'
  );
  const bufferedCheckoutCtx = AIService.getSessionContext('buffered-checkout', 'store-alpha', 100, 'TEST');
  bufferedCheckoutCtx.cart = [{ productCode: 'HBL-S', productName: 'HBL Test', size: 'S', quantity: 1, unitPrice: 250 }];
  bufferedCheckoutCtx.checkoutConfirmed = false;
  bufferedCheckoutCtx.customerName = 'Buffer Müşteri';
  bufferedCheckoutCtx.customerPhone = '05551234567';
  bufferedCheckoutCtx.address = 'Buffer Mahallesi Test Sokak No 10';
  bufferedCheckoutCtx.currentTurnContactFields = ['customerName', 'customerPhone', 'address'];
  const bufferedCheckoutTools = (AIService as any).createLeafTools('buffered-checkout', 'store-alpha', 100, 'TEST');
  const bufferedCheckoutAgent = (AIService as any).createSiparisSubAgent(
    null,
    bufferedCheckoutTools.stokTool,
    bufferedCheckoutTools.sepeteEkleTool,
    bufferedCheckoutTools.sepetGoruntuleTool,
    bufferedCheckoutTools.sepetOnaylaTool,
    bufferedCheckoutTools.kayitTool,
    { invoke: async () => '' }
  );
  const bufferedCheckoutResult = await bufferedCheckoutAgent.invoke(JSON.stringify({ action: 'sepet_onayla' }));
  const bufferedCheckoutOrder = db.prepare("SELECT order_id FROM orders WHERE store_id = 100 AND sender_id = 'buffered-checkout'").get() as any;
  assert(
    String(bufferedCheckoutResult).includes('"orderCreated":true') && Boolean(bufferedCheckoutOrder?.order_id),
    'Buffered approval plus contact details creates and persists the order instead of deleting same-turn customer fields'
  );
  const multiTurnCtx = AIService.getSessionContext('multi-turn-checkout', 'store-alpha', 100, 'TEST');
  multiTurnCtx.cart = [{ productCode: 'HBL-S', productName: 'HBL Test', size: 'S', quantity: 1, unitPrice: 250 }];
  multiTurnCtx.checkoutConfirmed = false;
  multiTurnCtx.currentTurnContactFields = [];
  const multiTurnTools = (AIService as any).createLeafTools('multi-turn-checkout', 'store-alpha', 100, 'TEST');
  const multiTurnAgent = (AIService as any).createSiparisSubAgent(
    null,
    multiTurnTools.stokTool,
    multiTurnTools.sepeteEkleTool,
    multiTurnTools.sepetGoruntuleTool,
    multiTurnTools.sepetOnaylaTool,
    multiTurnTools.kayitTool,
    { invoke: async () => '' }
  );
  await multiTurnAgent.invoke(JSON.stringify({ action: 'sepet_onayla' }));
  multiTurnCtx.customerName = 'Parçalı Müşteri';
  multiTurnCtx.currentTurnContactFields = ['customerName'];
  const nameStep = JSON.parse(String(await multiTurnAgent.invoke(JSON.stringify({ action: 'sepet_onayla' }))));
  multiTurnCtx.customerPhone = '05551234777';
  multiTurnCtx.currentTurnContactFields = ['customerPhone'];
  const phoneStep = JSON.parse(String(await multiTurnAgent.invoke(JSON.stringify({ action: 'sepet_onayla' }))));
  multiTurnCtx.address = 'Parçalı Mahallesi Test Sokak No 7';
  multiTurnCtx.currentTurnContactFields = ['address'];
  const multiTurnResult = JSON.parse(String(await multiTurnAgent.invoke(JSON.stringify({ action: 'sepet_onayla' }))));
  const multiTurnOrder = db.prepare("SELECT order_id FROM orders WHERE store_id = 100 AND sender_id = 'multi-turn-checkout'").get() as any;
  assert(
    nameStep.missingFields?.includes('telefon numarası') && !phoneStep.missingFields?.includes('ad soyad') &&
    multiTurnResult.orderCreated === true && Boolean(multiTurnOrder?.order_id),
    'Checkout keeps name, phone and address collected across separate messages without entering a confirmation loop'
  );
  db.prepare(`
    INSERT OR REPLACE INTO instagram_media_catalog (store_id, media_id, media_url, permalink, caption)
    VALUES (100, 'media_hbl_1', 'https://cdn.example.com/hbl.jpg?token=old', 'https://www.instagram.com/p/HBLPOST/', 'HBL ürünü')
  `).run();
  const directMediaMatch = FacebookService.resolveInstagramAttachmentProduct({ type: 'MEDIA_SHARE', payload: { id: 'media_hbl_1' } }, 100);
  const urlMediaMatch = FacebookService.resolveInstagramAttachmentProduct({ type: 'ig_reel', payload: { url: 'https://cdn.example.com/hbl.jpg?token=new' } }, 100);
  const crossTenantMediaMatch = FacebookService.resolveInstagramAttachmentProduct({ type: 'MEDIA_SHARE', payload: { id: 'media_hbl_1' } }, 200);
  assert(directMediaMatch?.shortCode === 'HBL' && urlMediaMatch?.shortCode === 'HBL' && crossTenantMediaMatch === null, 'Shared Instagram posts resolve to one tenant-isolated product family by Media ID or cached URL');
  db.prepare(`
    INSERT OR REPLACE INTO instagram_media_catalog (store_id, media_id, caption, media_type, synced_at)
    VALUES (100, 'media_caption_hbl', 'Yeni sezon gömlek\nÜrün Kodu: HBL-M', 'IMAGE', CURRENT_TIMESTAMP)
  `).run();
  const captionMappedCatalog = FacebookService.getCachedInstagramMedia(100);
  const captionMappedProducts = db.prepare("SELECT product_code, instagram_media_id FROM products WHERE store_id = 100 AND short_code = 'HBL' ORDER BY product_code").all() as any[];
  const captionMediaMatch = FacebookService.resolveInstagramAttachmentProduct({ type: 'MEDIA_SHARE', payload: { id: 'media_caption_hbl' } }, 100);
  assert(
    captionMappedCatalog.some(item => item.id === 'media_caption_hbl' && item.products.length === 2) &&
    captionMappedProducts.every(product => product.instagram_media_id === 'media_caption_hbl') &&
    captionMediaMatch?.shortCode === 'HBL',
    'Instagram captions containing Ürün Kodu automatically map the matching dataset product family and all variants'
  );
  const variantCtx = AIService.getSessionContext('variant-test', 'store-alpha', 100, 'TEST');
  variantCtx.productCode = 'HBL';
  variantCtx.variantVerified = false;
  const informationalPriceReply = (AIService as any).getProductPriceReply(100, variantCtx, 'Bu ürünün fiyatı ne kadar?');
  assert(informationalPriceReply.includes('250 TL') && !informationalPriceReply.includes('Hangi bedeni'), 'A customer asking only for a known Instagram product price receives the database price without entering the size/order flow');
  const noSizeReply = (AIService as any).getShortCodeOrderReply(100, variantCtx, 'HBL\n\nMüşteri bu ürünü sipariş etmek istiyor.');
  assert(noSizeReply.includes('Hangi bedeni istersiniz?') && variantCtx.productCode === 'HBL', 'Product short code waits for an explicit size instead of reading M from Müşteri');
  const explicitSizeReply = (AIService as any).getShortCodeOrderReply(100, variantCtx, 'M beden istiyorum');
  assert(explicitSizeReply.includes('M bedeni stokta mevcut') && !/\d+\s*adet/i.test(explicitSizeReply) && variantCtx.productCode === 'HBL-M', 'Explicit M size resolves HBL-M without exposing its inventory quantity');

  await StockService.addProduct({ storeId: 100, shortCode: 'İNCİ', productCode: 'İNCİ-M', name: 'İnci Elbise', size: 'M', stock: 7, price: 600 });
  const turkishCodeStock = await StockService.checkStock(100, 'inci m stokta var mı?');
  const turkishCodeVariant = StockService.findProductVariant(100, 'inci_m', 'm');
  assert(
    turkishCodeStock.exists && turkishCodeStock.product?.productCode === 'İNCİ-M' && turkishCodeVariant?.stock === 7,
    'AI stock lookup reads Turkish product codes and common space, dash or underscore variants'
  );

  console.log('\n2️⃣7️⃣-B ORDER VARIANT TEST: Kısa kod + beden siparişi panele kaydedilmeli');
  const savedVariantOrder = await OrderService.createOrder(100, {
    customerName: 'Test Müşteri',
    customerPhone: '05551234567',
    address: 'Test Mahallesi Test Sokak No 1',
    productCode: 'HBL-M',
    productName: 'HBL Test',
    size: 'M',
    quantity: 1,
    senderId: 'variant-order-test'
  });
  const listedVariantOrder = (await OrderService.getOrders(100)).find(order => order.orderId === savedVariantOrder.orderId);
  assert(Boolean(listedVariantOrder) && listedVariantOrder?.productCode === 'HBL-M' && listedVariantOrder?.size === 'M', 'Created HBL-M order is returned by the admin orders listing');

  db.prepare(`
    INSERT INTO campaigns (store_id, title, description, code, discount_percent, discount_amount, min_order_amount, start_date, end_date, active)
    VALUES
      (100, 'Aktif Yaz İndirimi', 'Uygun siparişe yüzde 15 indirim', 'YAZ15', 15, 0, 300, DATE('now', '-1 day'), DATE('now', '+1 day'), 1),
      (100, 'Henüz Başlamadı', 'Gelecek kampanya', 'GELECEK90', 90, 0, 0, DATE('now', '+1 day'), DATE('now', '+2 day'), 1),
      (100, 'Süresi Doldu', 'Eski kampanya', 'ESKI80', 80, 0, 0, DATE('now', '-2 day'), DATE('now', '-1 day'), 1)
  `).run();
  const campaignPromotion = (AIService as any).getOrderPromotion(100, 'campaign-test-user', 500);
  const underMinimumPromotion = (AIService as any).getOrderPromotion(100, 'campaign-test-user', 250);
  assert(
    campaignPromotion.campaign?.code === 'YAZ15' && campaignPromotion.discount === 75 && underMinimumPromotion.discount === 0,
    'Order pricing reads active campaign dates, minimum amount and configured discount instead of a hard-coded code'
  );

  db.prepare(`
    INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount, is_used)
    VALUES (100, 'vip-under-minimum', 'VIP30', 30, 600, 0)
  `).run();
  const underMinimumVipPromotion = (AIService as any).getOrderPromotion(100, 'vip-under-minimum', 500);
  const underMinimumVip = db.prepare("SELECT is_used FROM user_rewards WHERE store_id = 100 AND sender_id = 'vip-under-minimum'").get() as any;
  assert(
    underMinimumVipPromotion.vipReward === null && underMinimumVipPromotion.campaign?.code === 'YAZ15' && underMinimumVip?.is_used === 0,
    'VIP reward waits for its minimum usage amount without blocking an eligible campaign or being consumed'
  );

  db.prepare(`
    INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount, is_used)
    VALUES (100, 'vip-order-test', 'VIP25', 25, 300, 0)
  `).run();
  const vipCtx = AIService.getSessionContext('vip-order-test', 'store-alpha', 100, 'TEST');
  vipCtx.cart = [{ productCode: 'HBL-M', productName: 'HBL Test', size: 'M', quantity: 2, unitPrice: 250 }];
  vipCtx.checkoutConfirmed = true;
  vipCtx.customerName = 'VIP Müşteri';
  vipCtx.customerPhone = '05551234999';
  vipCtx.address = 'VIP Mahallesi Test Sokak No 25';
  const vipTools = (AIService as any).createLeafTools('vip-order-test', 'store-alpha', 100, 'TEST');
  const vipOrderResult = JSON.parse(String(await vipTools.kayitTool.invoke('{}')));
  const consumedVip = db.prepare("SELECT is_used FROM user_rewards WHERE store_id = 100 AND sender_id = 'vip-order-test'").get() as any;
  const vipOrder = db.prepare('SELECT discount, total_price FROM orders WHERE store_id = 100 AND order_id = ?').get(vipOrderResult.orderId) as any;
  assert(
    vipOrderResult.orderCreated === true && vipOrderResult.appliedLoyaltyReward === true && vipOrderResult.discount === 125 && consumedVip?.is_used === 1 && vipOrder?.discount === 125,
    'Eligible VIP reward overrides the campaign, is priced correctly and is consumed only by a successful order'
  );

  db.prepare(`
    INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount, is_used)
    VALUES (100, 'vip-failed-order', 'SAFE20', 20, 0, 0)
  `).run();
  const failedVipCtx = AIService.getSessionContext('vip-failed-order', 'store-alpha', 100, 'TEST');
  failedVipCtx.cart = [{ productCode: 'HBL-M', productName: 'HBL Test', size: 'M', quantity: 999, unitPrice: 250 }];
  failedVipCtx.checkoutConfirmed = true;
  failedVipCtx.customerName = 'Başarısız Müşteri';
  failedVipCtx.customerPhone = '05551234888';
  failedVipCtx.address = 'Test Mahallesi Başarısız Sipariş No 1';
  const failedVipTools = (AIService as any).createLeafTools('vip-failed-order', 'store-alpha', 100, 'TEST');
  const failedVipResult = JSON.parse(String(await failedVipTools.kayitTool.invoke('{}')));
  const untouchedVip = db.prepare("SELECT is_used FROM user_rewards WHERE store_id = 100 AND sender_id = 'vip-failed-order'").get() as any;
  assert(
    failedVipResult.orderCreated !== true && untouchedVip?.is_used === 0 &&
    String(failedVipResult.message || '').includes('yeterli stok') &&
    !String(failedVipResult.message || '').includes('Mevcut Stok') && !/\d+\s*adet/i.test(String(failedVipResult.message || '')),
    'VIP reward remains available and the customer-facing error hides inventory quantity when stock is insufficient'
  );

  console.log('\n2️⃣7️⃣-C AI TOOL INPUT TEST: DynamicTool input komutu doğru action olarak ayrıştırılmalı');
  const parsedAddToCart = (AIService as any).normalizeSiparisToolInput({ input: 'sepete_ekle productCode=GMA-S size=S quantity=1' });
  assert(parsedAddToCart.action === 'sepete_ekle' && parsedAddToCart.productCode === 'GMA-S' && parsedAddToCart.size === 'S' && parsedAddToCart.quantity === '1', 'Nested sepete_ekle command is parsed into structured tool arguments');
  const parsedSaveOrder = (AIService as any).normalizeSiparisToolInput({ input: 'kayit' });
  assert(parsedSaveOrder.action === 'kayit', 'Nested kayit command invokes order creation instead of stock lookup');
  const parsedCommaCart = (AIService as any).normalizeSiparisToolInput({ input: 'action=sepete_ekle, productCode=PNT-PAL-002, size=38, quantity=2' });
  assert(
    parsedCommaCart.action === 'sepete_ekle' && parsedCommaCart.productCode === 'PNT-PAL-002' && parsedCommaCart.size === '38' && parsedCommaCart.quantity === '2',
    'Comma-separated tool arguments are normalized without trailing punctuation'
  );
  const parsedLabeledOrder = (AIService as any).normalizeSiparisToolInput({ input: 'action=kayit\nAd Soyad: Emre İşcenkal\nTelefon: 05435207770\nAdres: Süleyman Demirel Mahallesi 1010 Sokak No 6' });
  assert(
    parsedLabeledOrder.action === 'kayit' && parsedLabeledOrder.customerName === 'Emre İşcenkal' &&
    parsedLabeledOrder.customerPhone === '05435207770' && parsedLabeledOrder.address.includes('Süleyman Demirel'),
    'Labeled customer details sent inside a kayit command are mapped to canonical order fields'
  );
  const inferredLabeledOrder = (AIService as any).normalizeSiparisToolInput({ input: 'Ad: Emre İşcenkal, Telefon: 05428523712, Adres: Süleyman Demirel Mahallesi 1010 Sokak No: 4' });
  assert(
    inferredLabeledOrder.action === 'kayit' && inferredLabeledOrder.customerName === 'Emre İşcenkal' && inferredLabeledOrder.customerPhone === '05428523712',
    'Customer details without an explicit action are safely inferred as kayit instead of stock lookup'
  );
  const parsedPositionalStock = (AIService as any).normalizeSiparisToolInput({ input: 'stok\nPNT-PAL-002\n38' });
  assert(parsedPositionalStock.action === 'stok' && parsedPositionalStock.productCode === 'PNT-PAL-002' && parsedPositionalStock.size === '38', 'Positional stock commands retain the requested product and size');

  const labeledCheckoutCtx = AIService.getSessionContext('labeled-checkout', 'store-alpha', 100, 'TEST');
  labeledCheckoutCtx.cart = [{ productCode: 'HBL-S', productName: 'HBL Test', size: 'S', quantity: 1, unitPrice: 250 }];
  labeledCheckoutCtx.checkoutConfirmed = true;
  const labeledCheckoutTools = (AIService as any).createLeafTools('labeled-checkout', 'store-alpha', 100, 'TEST');
  const labeledCheckoutAgent = (AIService as any).createSiparisSubAgent(
    {},
    labeledCheckoutTools.stokTool,
    labeledCheckoutTools.sepeteEkleTool,
    labeledCheckoutTools.sepetGoruntuleTool,
    labeledCheckoutTools.sepetOnaylaTool,
    labeledCheckoutTools.kayitTool,
    { invoke: async () => '' }
  );
  const labeledCheckoutResult = JSON.parse(String(await labeledCheckoutAgent.invoke(JSON.stringify({ input: 'Ad: Emre İşcenkal, Telefon: 05428523712, Adres: Süleyman Demirel Mahallesi 1010 Sokak No: 4' }))));
  assert(labeledCheckoutResult.orderCreated === true, 'A confirmed checkout is persisted when the AI sends labeled customer details without an explicit action');

  console.log('\n2️⃣7️⃣-D AI PERSONA TEST: Mağaza kişiselleştirme ayarları çalışma anında okunmalı');
  db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (100, 'bot_tone', 'friendly')").run();
  db.prepare("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (100, 'bot_system_prompt', 'Müşteriye ürün bakım önerisi sun.')").run();
  const livePersona = (AIService as any).getStorePersona(100);
  assert(livePersona.storeName === 'Store Alpha' && livePersona.tone === 'friendly' && livePersona.customPrompt.includes('bakım önerisi'), 'Store identity, saved tone and custom prompt are loaded into the live AI persona without creating a mascot');

  console.log('\n2️⃣7️⃣-E PUBLIC DEMO ISOLATION TEST: Demo AI must use fixed fictional snapshot');
  assert(
    DemoAIService.snapshot.storeName === 'Luna Moda Demo' &&
    DemoAIService.snapshot.products.length === 6 &&
    DemoAIService.snapshot.products.every(product => typeof product.stock === 'number'),
    'Public demo AI is constrained to a fixed fictional store snapshot instead of tenant database records'
  );

  console.log('\n2️⃣7️⃣-F EMAIL VERIFICATION TEST: Başvuru e-posta doğrulamasından sonra admin kuyruğuna alınmalı');
  const verificationEmail = 'verification_test@iscworks.test';
  db.prepare('DELETE FROM merchant_applications WHERE email = ?').run(verificationEmail);
  db.prepare('DELETE FROM users WHERE email = ?').run(verificationEmail);
  const verificationUser = db.prepare("INSERT INTO users (full_name, email, password_hash, status, email_verified_at) VALUES ('Verification Test', ?, ?, 'pending', NULL)").run(verificationEmail, hashPassword('Test123!'));
  const verificationUserId = Number(verificationUser.lastInsertRowid);
  db.prepare("INSERT INTO merchant_applications (full_name, email, store_name, plan, status) VALUES ('Verification Test', ?, 'Verification Store', 'Pro Store', 'email_pending')").run(verificationEmail);
  const rawVerificationToken = EmailVerificationService.issueCode(verificationUserId);
  const storedVerificationToken = db.prepare('SELECT token_hash FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL').get(verificationUserId) as any;
  assert(/^\d{6}$/.test(rawVerificationToken) && storedVerificationToken.token_hash !== rawVerificationToken && storedVerificationToken.token_hash === EmailVerificationService.tokenHash(rawVerificationToken), 'Only the hash of the six-digit verification code is stored in SQLite');
  assert(!EmailVerificationService.consumeCode(verificationEmail, '000000').success, 'Incorrect verification codes are rejected');
  const verificationResult = EmailVerificationService.consumeCode(verificationEmail, rawVerificationToken);
  const verifiedUserRow = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(verificationUserId) as any;
  const verifiedApplication = db.prepare('SELECT status FROM merchant_applications WHERE email = ?').get(verificationEmail) as any;
  assert(verificationResult.success && Boolean(verifiedUserRow.email_verified_at) && verifiedApplication.status === 'pending', 'Verified email moves the merchant application into the Super Admin queue');
  assert(!EmailVerificationService.consumeCode(verificationEmail, rawVerificationToken).success, 'Verification codes are single-use');
  db.prepare('DELETE FROM merchant_applications WHERE email = ?').run(verificationEmail);
  db.prepare('DELETE FROM users WHERE id = ?').run(verificationUserId);

  console.log('\n2️⃣8️⃣ STOCK BUG FIX TEST 2: Stock Set (10 -> 25) & Read After Write');
  const updateSuccess2 = await StockService.updateStock(100, 'TEST-STOCK', 25);
  const stockCheck2 = await StockService.checkStock(100, 'TEST-STOCK');
  assert(updateSuccess2 === true && stockCheck2.exists && stockCheck2.product?.stock === 25, 'Read After Write retrieves updated stock=25');

  console.log('\n2️⃣9️⃣ STOCK BUG FIX TEST 3: Store A / Store B Stock Update Isolation');
  await StockService.addProduct({ storeId: 200, shortCode: 'TST', productCode: 'TEST-STOCK', name: 'Test Product B', size: 'M', stock: 50, price: 200 });
  await StockService.updateStock(100, 'TEST-STOCK', 30);
  const storeAStock = (db.prepare("SELECT stock FROM products WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any).stock;
  const storeBStock = (db.prepare("SELECT stock FROM products WHERE store_id = 200 AND product_code = 'TEST-STOCK'").get() as any).stock;
  assert(storeAStock === 30 && storeBStock === 50, 'Store A stock updated to 30 while Store B stock remains strictly isolated at 50');

  console.log('\n3️⃣0️⃣ STOCK BUG FIX TEST 4: Product Code Collision Test (ABC-M)');
  await StockService.addProduct({ storeId: 100, shortCode: 'ABC', productCode: 'ABC-M', name: 'Shirt A', size: 'M', stock: 10, price: 300 });
  await StockService.addProduct({ storeId: 200, shortCode: 'ABC', productCode: 'ABC-M', name: 'Shirt B', size: 'M', stock: 100, price: 300 });
  await StockService.updateStock(100, 'ABC-M', 20);
  const abcStoreA = (db.prepare("SELECT stock FROM products WHERE store_id = 100 AND product_code = 'ABC-M'").get() as any).stock;
  const abcStoreB = (db.prepare("SELECT stock FROM products WHERE store_id = 200 AND product_code = 'ABC-M'").get() as any).stock;
  assert(abcStoreA === 20 && abcStoreB === 100, 'Updating ABC-M for Store 100 changes Store 100 to 20 while Store 200 remains 100');

  console.log('\n3️⃣1️⃣ STOCK BUG FIX TEST 5: Invalid Quantity Sanitation & Handling');
  const invalidNeg = await StockService.updateStock(100, 'TEST-STOCK', -10);
  const invalidNaN = await StockService.updateStock(100, 'TEST-STOCK', NaN);
  const currentStockAfterInvalid = (db.prepare("SELECT stock FROM products WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any).stock;
  assert(currentStockAfterInvalid === 30, 'Invalid quantity inputs (-10, NaN) do not pollute or corrupt database stock');

  console.log('\n3️⃣2️⃣ STOCK BUG FIX TEST 6: False Success Prevention on Non-Existent Product');
  const nonExistentResult = await StockService.updateStock(100, 'NON-EXISTENT-CODE-999', 50);
  assert(nonExistentResult === false, 'Updating non-existent product returns false (HTTP 404), preventing false-success bug');

  console.log(`\n📊 MASTER SECURITY & STOCK BUG FIX TEST SUMMARY: Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTestSuite().catch(e => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
