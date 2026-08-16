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

    const [dashboardPage, stockPage] = await Promise.all([
      fetch(`${origin}/admin/index.html`),
      fetch(`${origin}/admin/stock.html`)
    ]);
    const dashboardHtml = await dashboardPage.text();
    const stockHtml = await stockPage.text();
    assert(
      dashboardPage.ok
        && stockPage.ok
        && !dashboardHtml.includes('id="productsTableBody"')
        && stockHtml.includes('id="productsTableBody"')
        && stockHtml.includes('Stok Yönetimi'),
      'Dashboard analytics and editable stock management are served as separate pages'
    );

    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password })
    });
    const loginBody = await login.json() as any;
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert(login.ok && loginBody.token && cookie.startsWith('iscworks_session='), 'Login issues an HttpOnly browser session cookie');

    const settings = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const settingsBody = await settings.json() as any;
    assert(settings.ok && settingsBody.settings.shipping_fee === '49' && !JSON.stringify(settingsBody).includes('must-never-leak'), 'Settings API never exposes integration secrets');

    const forbiddenSetting = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'facebook_page_access_token', value: 'replace-me' })
    });
    assert(forbiddenSetting.status === 400, 'Generic settings endpoint rejects secret credential writes');

    const csrfRejected = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'shipping_fee', value: '50' })
    });
    assert(csrfRejected.status === 403, 'Cookie-authenticated cross-site writes are rejected');

    const unusualCsv = 'stok_kodu;urun_basligi;varyant;satis_fiyati;mevcut_adet\nHBL-M;HBL Gömlek;Medium;₺799,90;24';
    const analyzedImport = await fetch(`${origin}/api/data-import/analyze`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'csv', sourceName: 'unusual.csv', content: unusualCsv })
    });
    const analyzedBody = await analyzedImport.json() as any;
    assert(analyzedImport.ok && analyzedBody.validCount === 1 && analyzedBody.sampleRows[0].productCode === 'HBL-M' && analyzedBody.sampleRows[0].price === 799.9, 'Unfamiliar CSV headers are mapped into the canonical product model');

    const committedImport = await fetch(`${origin}/api/data-import/commit`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken: analyzedBody.previewToken, saveProfile: true, profileName: 'HTTP mapping profile' })
    });
    const importedProduct = db.prepare('SELECT name, size, price, stock FROM products WHERE store_id = ? AND product_code = ?').get(storeId, 'HBL-M') as any;
    assert(committedImport.ok && importedProduct?.name === 'HBL Gömlek' && importedProduct?.size === 'M' && importedProduct?.stock === 24, 'Approved import atomically persists only to the authenticated store');

    const oauthError = await fetch(`${origin}/api/integrations/instagram/callback?error=${encodeURIComponent('<script>alert(1)</script>')}`);
    const oauthHtml = await oauthError.text();
    assert(!oauthHtml.includes('<script>alert(1)</script>') && oauthHtml.includes('&lt;script&gt;'), 'OAuth error page escapes reflected HTML');

    const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    const revoked = await fetch(`${origin}/api/auth/verify`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
    assert(logout.ok && revoked.status === 401, 'Logout immediately revokes the issued session');
    console.log(`HTTP SECURITY TEST SUMMARY: Passed: ${passed} | Failed: 0`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
