import './test-env';
import { AddressInfo } from 'net';
import { app } from '../index';
import { db, hashPassword } from '../database/db';

async function run(): Promise<void> {
  const email = 'http-security-test@iscworks.test';
  const slug = 'http-security-test';
  const password = 'Secure Test1!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  if (existing) {
    const store = db.prepare('SELECT id FROM stores WHERE owner_id = ?').get(existing.id) as { id: number } | undefined;
    if (store) db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
  }

  const userResult = db.prepare("INSERT INTO users (full_name, email, password_hash, status, email_verified_at) VALUES ('HTTP Test', ?, ?, 'active', CURRENT_TIMESTAMP)").run(email, hashPassword(password));
  const userId = Number(userResult.lastInsertRowid);
  const storeResult = db.prepare("INSERT INTO stores (owner_id, name, slug, status) VALUES (?, 'HTTP Security Store', ?, 'active')").run(userId, slug);
  const storeId = Number(storeResult.lastInsertRowid);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (?, ?, 'OWNER', 'active')").run(userId, storeId);
  db.prepare("INSERT INTO store_subscriptions (store_id, plan_name, duration_months, starts_at, ends_at) VALUES (?, 'Pro Store', 12, date('now'), date('now', '+12 months'))").run(storeId);
  db.prepare("INSERT INTO settings (store_id, key, value) VALUES (?, 'shipping_fee', '49')").run(storeId);
  db.prepare("INSERT INTO settings (store_id, key, value) VALUES (?, 'facebook_page_access_token', 'must-never-leak')").run(storeId);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  let passed = 0;
  const assert = (condition: boolean, name: string) => {
    if (!condition) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  ✅ PASS: ${name}`);
  };

  try {
    const health = await fetch(`${origin}/healthz`);
    assert(health.ok && health.headers.get('x-content-type-options') === 'nosniff', 'Health endpoint and security headers are active');

    const [oldMasterLogin, privateMasterLogin, publicHomepage] = await Promise.all([
      fetch(`${origin}/master-admin/login`),
      fetch(`${origin}/platform-test-console/login`),
      fetch(`${origin}/`)
    ]);
    const oldMasterHtml = await oldMasterLogin.text();
    const privateMasterHtml = await privateMasterLogin.text();
    const publicHomepageHtml = await publicHomepage.text();
    assert(
      oldMasterLogin.status === 404
        && !oldMasterHtml.includes('Platform Konsoluna Giriş Yap')
        && privateMasterLogin.ok
        && String(privateMasterLogin.headers.get('x-robots-tag')).includes('noindex')
        && privateMasterHtml.includes('X-Master-Panel-Key')
        && !publicHomepageHtml.includes('/master-admin'),
      'Master Admin console is available only on the private noindex path and is not linked publicly'
    );

    const [dashboardPage, stockPage, instagramMediaPage] = await Promise.all([
      fetch(`${origin}/admin/index.html`),
      fetch(`${origin}/admin/stock.html`),
      fetch(`${origin}/admin/instagram-media.html`)
    ]);
    const dashboardHtml = await dashboardPage.text();
    const stockHtml = await stockPage.text();
    const instagramMediaHtml = await instagramMediaPage.text();
    assert(
      dashboardPage.ok
        && stockPage.ok
        && instagramMediaPage.ok
        && dashboardHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && stockHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && instagramMediaHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && !dashboardHtml.includes('id="productsTableBody"')
        && stockHtml.includes('id="productsTableBody"')
        && stockHtml.includes('Stok Yönetimi')
        && stockHtml.includes('id="lowStockKpi"')
        && stockHtml.includes('id="outOfStockKpi"')
        && stockHtml.includes('id="stockAlertModal"'),
      'Dashboard analytics and editable stock management are served as separate pages'
    );

    const [missingPage, missingApi] = await Promise.all([
      fetch(`${origin}/admin/lgn`),
      fetch(`${origin}/api/does-not-exist`)
    ]);
    const missingPageHtml = await missingPage.text();
    const missingApiBody = await missingApi.json() as any;
    assert(
      missingPage.status === 404
        && missingPageHtml.includes('Aradığınız sayfa burada değil.')
        && missingPageHtml.includes('id="requestedPath"')
        && missingApi.status === 404
        && missingApiBody.success === false,
      'Unknown browser routes show the branded 404 page while unknown APIs stay JSON'
    );

    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password })
    });
    const loginBody = await login.json() as any;
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert(login.ok && loginBody.token && cookie.startsWith('iscworks_session='), 'Login issues an HttpOnly browser session cookie');

    db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (?, 1, 'OWNER', 'active')").run(userId);
    const masterLoginWithoutPanelKey = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password, storeId: 1 })
    });
    const masterLoginWithPanelKey = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Master-Panel-Key': 'platform-test-console' }, body: JSON.stringify({ email, password, storeId: 1 })
    });
    const keyedMasterBody = await masterLoginWithPanelKey.json() as any;
    assert(masterLoginWithoutPanelKey.status === 401 && masterLoginWithPanelKey.ok && keyedMasterBody.user?.storeId === 1, 'Master account login requires the private panel path key even when credentials are correct');
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND store_id = 1').run(userId);

    const adminAppScript = await fetch(`${origin}/admin/app.js`);
    const adminAppSource = await adminAppScript.text();
    assert(
      adminAppScript.ok
        && adminAppSource.includes('loadPlanExpiryBanner()')
        && adminAppSource.includes('Planınız sona erdi.')
        && adminAppSource.includes('Kesintiye uğramamak için yenileme yapınız.'),
      'Every merchant page can render the shared expired-plan renewal warning'
    );

    db.prepare("UPDATE store_subscriptions SET ends_at = date('now', '-1 day') WHERE store_id = ?").run(storeId);
    const expiredPlan = await fetch(`${origin}/api/plan`, { headers: { Cookie: cookie } });
    const expiredPlanBody = await expiredPlan.json() as any;
    assert(expiredPlan.ok && Number(expiredPlanBody.subscription?.remaining_days) < 0, 'Expired subscription status remains readable for the global renewal warning');
    db.prepare("UPDATE store_subscriptions SET ends_at = date('now', '+12 months') WHERE store_id = ?").run(storeId);

    const settings = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const settingsBody = await settings.json() as any;
    assert(settings.ok && settingsBody.settings.shipping_fee === '49' && !JSON.stringify(settingsBody).includes('must-never-leak'), 'Settings API never exposes integration secrets');

    const forbiddenSetting = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'facebook_page_access_token', value: 'replace-me' })
    });
    assert(forbiddenSetting.status === 400, 'Generic settings endpoint rejects secret credential writes');

    const autoVipSetting = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'auto_vip_reward_enabled', value: '1' })
    });
    const refreshedSettings = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const refreshedSettingsBody = await refreshedSettings.json() as any;
    assert(
      autoVipSetting.ok && refreshedSettingsBody.settings.auto_vip_reward_enabled === '1',
      'Automatic VIP reward setting can be saved and read by the merchant panel'
    );

    const csrfRejected = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'shipping_fee', value: '50' })
    });
    assert(csrfRejected.status === 403, 'Cookie-authenticated cross-site writes are rejected');

    const unusualCsv = 'stok_kodu;urun_basligi;varyant;satis_fiyati;mevcut_adet;instagram_media_id\nHBL-M;HBL Gömlek;Medium;₺799,90;24;media_http_1';
    const analyzedImport = await fetch(`${origin}/api/data-import/analyze`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'csv', sourceName: 'unusual.csv', content: unusualCsv })
    });
    const analyzedBody = await analyzedImport.json() as any;
    assert(analyzedImport.ok && analyzedBody.validCount === 1 && analyzedBody.sampleRows[0].productCode === 'HBL-M' && analyzedBody.sampleRows[0].price === 799.9 && analyzedBody.sampleRows[0].instagramMediaId === 'media_http_1', 'Unfamiliar CSV headers including Instagram Media ID are mapped into the canonical product model');

    const committedImport = await fetch(`${origin}/api/data-import/commit`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: analyzedBody.previewToken, saveProfile: true, profileName: 'HTTP mapping profile' })
    });
    const importedProduct = db.prepare('SELECT name, size, price, stock, instagram_media_id FROM products WHERE store_id = ? AND product_code = ?').get(storeId, 'HBL-M') as any;
    assert(committedImport.ok && importedProduct?.name === 'HBL Gömlek' && importedProduct?.size === 'M' && importedProduct?.stock === 24 && importedProduct?.instagram_media_id === 'media_http_1', 'Approved import atomically persists Media ID only to the authenticated store');

    db.prepare(`
      INSERT INTO instagram_media_catalog (store_id, media_id, caption, media_type, synced_at)
      VALUES (?, 'media_http_assign', 'HTTP assignment post', 'IMAGE', CURRENT_TIMESTAMP)
    `).run(storeId);
    const assignedMedia = await fetch(`${origin}/api/integrations/instagram/media/media_http_assign/assignment`, {
      method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ shortCode: 'HBL' })
    });
    const assignedBody = await assignedMedia.json() as any;
    const assignedProduct = db.prepare('SELECT instagram_media_id FROM products WHERE store_id = ? AND product_code = ?').get(storeId, 'HBL-M') as any;
    assert(assignedMedia.ok && assignedBody.products?.[0]?.shortCode === 'HBL' && assignedProduct?.instagram_media_id === 'media_http_assign', 'A catalog post can be assigned to a tenant product family from the media detail page');

    db.prepare(`
      INSERT INTO instagram_media_catalog (store_id, media_id, caption, media_type, synced_at)
      VALUES (?, 'media_import_reconcile', 'Yeni ürün\nÜrün Kodu: CAP-M', 'IMAGE', CURRENT_TIMESTAMP)
    `).run(storeId);
    const lateProductAnalysis = await fetch(`${origin}/api/data-import/analyze`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'csv', sourceName: 'late-product.csv', content: 'urun_kodu;urun_adi;beden;fiyat;stok\nCAP-M;Caption Product;M;650;9' })
    });
    const lateProductPreview = await lateProductAnalysis.json() as any;
    const lateProductCommit = await fetch(`${origin}/api/data-import/commit`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: lateProductPreview.previewToken })
    });
    const lateMappedProduct = db.prepare("SELECT instagram_media_id FROM products WHERE store_id = ? AND product_code = 'CAP-M'").get(storeId) as any;
    assert(lateProductAnalysis.ok && lateProductCommit.ok && lateMappedProduct?.instagram_media_id === 'media_import_reconcile', 'A newly imported dataset is immediately reconciled with cached Instagram caption product codes without opening the media page');

    const disconnectedMediaCatalog = await fetch(`${origin}/api/integrations/instagram/media`, { headers: { Cookie: cookie } });
    assert(disconnectedMediaCatalog.status === 409, 'Instagram media catalog requires a connected tenant account without exposing credentials');

    const commentsDisabled = await fetch(`${origin}/api/integrations/instagram/comments`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    assert(commentsDisabled.status === 410, 'Instagram comment access cannot be enabled while media-only mode is active');

    const oauthError = await fetch(`${origin}/api/integrations/instagram/callback?error=${encodeURIComponent('<script>alert(1)</script>')}`);
    const oauthHtml = await oauthError.text();
    assert(!oauthHtml.includes('<script>alert(1)</script>') && oauthHtml.includes('&lt;script&gt;'), 'OAuth error page escapes reflected HTML');

    const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    const revoked = await fetch(`${origin}/api/auth/verify`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
    assert(logout.ok && revoked.status === 401, 'Logout immediately revokes the issued session');
    console.log(`HTTP SECURITY TEST SUMMARY: Passed: ${passed} | Failed: 0`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.prepare('DELETE FROM memberships WHERE user_id = ? AND store_id = 1').run(userId);
    db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
