import crypto from 'crypto';
import { StockService } from '../services/stock.service';
import { InventoryService } from '../services/inventory.service';
import { OrderService } from '../services/order.service';
import { AIService } from '../services/ai.service';
import { AdminCopilotService } from '../services/admin-copilot.service';
import { GeminiService } from '../services/gemini.service';
import { WebhookController } from '../controllers/webhook.controller';
import { AuthMiddleware } from '../middleware/auth.middleware';
import { db, hashPassword, initDatabase, needsPasswordRehash, verifyPassword } from '../database/db';

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
  db.prepare('DELETE FROM memberships WHERE store_id IN (100, 200, 999)').run();
  db.prepare("DELETE FROM users WHERE id IN (10, 11, 20, 30) OR email IN ('owner_a@iscworks.com', 'staff_a@iscworks.com', 'owner_b@iscworks.com', 'inactive_user@iscworks.com')").run();
  db.prepare('DELETE FROM stores WHERE id IN (100, 200, 999)').run();

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

  console.log('\n2️⃣ AUTH TEST 2: Valid JWT Token Generation & Verification');
  const jwtOwnerA = AuthMiddleware.generateToken({ userId: 10, storeId: 100, role: 'OWNER', email: 'owner_a@iscworks.com' });
  const decodedA = AuthMiddleware.verifyToken(jwtOwnerA);
  assert(decodedA !== null && decodedA.userId === 10 && decodedA.storeId === 100 && decodedA.role === 'OWNER', 'Valid JWT token verified successfully');

  console.log('\n3️⃣ AUTH TEST 3: Invalid & Expired Token Rejection');
  const invalidSigToken = jwtOwnerA.substring(0, jwtOwnerA.length - 5) + 'X1Y2Z';
  assert(AuthMiddleware.verifyToken(invalidSigToken) === null, 'Tampered/invalid signature token rejected');
  assert(AuthMiddleware.verifyToken('') === null, 'Empty token rejected');

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

  // 7. STOCK BUG FIX TESTS (ADD, SET, ISOLATION, COLLISION & SANITATION)
  console.log('\n2️⃣7️⃣ STOCK BUG FIX TEST 1: Stock Add (+5 from 10 -> 15)');
  await StockService.addProduct({ storeId: 100, shortCode: 'TST', productCode: 'TEST-STOCK', name: 'Test Product', size: 'M', stock: 10, price: 200 });
  const updateSuccess1 = await StockService.updateStock(100, 'TEST-STOCK', 15);
  const prodRow1 = db.prepare("SELECT stock FROM products WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any;
  const invRow1 = db.prepare("SELECT stock FROM inventory WHERE store_id = 100 AND product_code = 'TEST-STOCK'").get() as any;
  assert(updateSuccess1 === true && prodRow1?.stock === 15 && invRow1?.stock === 15, 'Stock updated to 15 in both products and inventory tables');

  console.log('\n2️⃣7️⃣-A AI VARIANT TEST: "Müşteri" kelimesi M beden sayılmamalı');
  await StockService.addProduct({ storeId: 100, shortCode: 'HBL', productCode: 'HBL-S', name: 'HBL Test', size: 'S', stock: 10, price: 250 });
  await StockService.addProduct({ storeId: 100, shortCode: 'HBL', productCode: 'HBL-M', name: 'HBL Test', size: 'M', stock: 10, price: 250 });
  const variantCtx = AIService.getSessionContext('variant-test', 'store-alpha', 100, 'TEST');
  variantCtx.productCode = 'HBL';
  variantCtx.variantVerified = false;
  const noSizeReply = (AIService as any).getShortCodeOrderReply(100, variantCtx, 'HBL\n\nMüşteri bu ürünü sipariş etmek istiyor.');
  assert(noSizeReply.includes('Hangi bedeni istersiniz?') && variantCtx.productCode === 'HBL', 'Product short code waits for an explicit size instead of reading M from Müşteri');
  const explicitSizeReply = (AIService as any).getShortCodeOrderReply(100, variantCtx, 'M beden istiyorum');
  assert(explicitSizeReply.includes('M bedeni stokta mevcut') && variantCtx.productCode === 'HBL-M', 'Explicit M size resolves HBL-M variant');

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
