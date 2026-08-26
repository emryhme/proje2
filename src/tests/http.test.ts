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
  db.prepare('DELETE FROM merchant_applications WHERE email = ?').run(email);

  const userResult = db.prepare("INSERT INTO users (full_name, email, password_hash, status, email_verified_at) VALUES ('HTTP Test', ?, ?, 'active', CURRENT_TIMESTAMP)").run(email, hashPassword(password));
  const userId = Number(userResult.lastInsertRowid);
  const storeResult = db.prepare("INSERT INTO stores (owner_id, name, slug, status) VALUES (?, 'HTTP Security Store', ?, 'active')").run(userId, slug);
  const storeId = Number(storeResult.lastInsertRowid);
  db.prepare("INSERT INTO memberships (user_id, store_id, role, status) VALUES (?, ?, 'OWNER', 'active')").run(userId, storeId);
  db.prepare("INSERT INTO merchant_applications (full_name, email, store_name, plan, status) VALUES ('HTTP Test', ?, 'HTTP Security Store', 'Pro Store', 'approved')").run(email);
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
      fetch(`${origin}/mstrtest9/login`),
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

    const [dashboardPage, stockPage, instagramMediaPage, legacyDashboard, legacyLegal] = await Promise.all([
      fetch(`${origin}/admin/dashboard`),
      fetch(`${origin}/admin/stock`),
      fetch(`${origin}/admin/instagram-media`),
      fetch(`${origin}/admin/index.html`, { redirect: 'manual' }),
      fetch(`${origin}/gizlilik.html`, { redirect: 'manual' })
    ]);
    const dashboardHtml = await dashboardPage.text();
    const stockHtml = await stockPage.text();
    const instagramMediaHtml = await instagramMediaPage.text();
    assert(
      dashboardPage.ok
        && stockPage.ok
        && instagramMediaPage.ok
        && legacyDashboard.status === 301
        && legacyDashboard.headers.get('location') === '/admin/dashboard'
        && legacyLegal.status === 301
        && legacyLegal.headers.get('location') === '/gizlilik'
        && dashboardHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && stockHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && instagramMediaHtml.includes('app.js?v=20260817-plan-expiry-v2')
        && !dashboardHtml.includes('id="productsTableBody"')
        && stockHtml.includes('id="productsTableBody"')
        && stockHtml.includes('Stok Yönetimi')
        && stockHtml.includes('id="lowStockKpi"')
        && stockHtml.includes('id="outOfStockKpi"')
        && stockHtml.includes('id="stockAlertModal"'),
      'Clean page URLs work and legacy HTML URLs redirect to their canonical routes'
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
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Master-Panel-Key': 'mstrtest9' }, body: JSON.stringify({ email, password, storeId: 1 })
    });
    const keyedMasterBody = await masterLoginWithPanelKey.json() as any;
    const masterCookie = String(masterLoginWithPanelKey.headers.get('set-cookie') || '').split(';')[0];
    assert(masterLoginWithoutPanelKey.status === 401 && masterLoginWithPanelKey.ok && keyedMasterBody.user?.storeId === 1, 'Master account login requires the private panel path key even when credentials are correct');

    const merchantDetail = await fetch(`${origin}/api/master-admin/merchants/${storeId}`, { headers: { Cookie: masterCookie } });
    const merchantDetailBody = await merchantDetail.json() as any;
    const serializedMerchantDetail = JSON.stringify(merchantDetailBody);
    assert(
      merchantDetail.ok
        && merchantDetailBody.detail?.owner?.id === userId
        && merchantDetailBody.detail?.owner?.email_verified_at
        && merchantDetailBody.detail?.membership?.role === 'OWNER'
        && merchantDetailBody.detail?.subscription?.plan_name === 'Pro Store'
        && !serializedMerchantDetail.includes('password_hash')
        && !serializedMerchantDetail.includes('webhook_verify_token')
        && !serializedMerchantDetail.includes('must-never-leak'),
      'Merchant detail exposes safe account and plan fields without credentials or integration secrets'
    );

    const masterOpenAiKey = 'sk-master-assigned-openai-12345678901234567890';
    const masterGeminiKey = 'AIza-master-assigned-gemini-123456789012345';
    const masterSavedAi = await fetch(`${origin}/api/master-admin/stores/${storeId}/ai-settings`, {
      method: 'POST',
      headers: { Cookie: masterCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', openaiApiKey: masterOpenAiKey, geminiApiKey: masterGeminiKey })
    });
    const masterSavedAiBody = await masterSavedAi.json() as any;
    const merchantDetailAfterAi = await fetch(`${origin}/api/master-admin/merchants/${storeId}`, { headers: { Cookie: masterCookie } });
    const merchantDetailAfterAiBody = await merchantDetailAfterAi.json() as any;
    const masterStoredOpenAi = String((db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'openai_api_key'").get(storeId) as any)?.value || '');
    const masterStoredGemini = String((db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'gemini_api_key'").get(storeId) as any)?.value || '');
    const merchantRejectedMasterAi = await fetch(`${origin}/api/master-admin/stores/${storeId}/ai-settings`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' })
    });
    assert(
      masterSavedAi.ok
        && masterSavedAiBody.aiSettings?.provider === 'gemini'
        && masterSavedAiBody.aiSettings?.openaiConfigured === true
        && masterSavedAiBody.aiSettings?.geminiConfigured === true
        && merchantDetailAfterAiBody.detail?.aiSettings?.provider === 'gemini'
        && merchantDetailAfterAiBody.detail?.aiSettings?.openaiConfigured === true
        && merchantDetailAfterAiBody.detail?.aiSettings?.geminiConfigured === true
        && masterStoredOpenAi.startsWith('sv1:')
        && masterStoredGemini.startsWith('sv1:')
        && !JSON.stringify(masterSavedAiBody).includes(masterOpenAiKey)
        && !JSON.stringify(merchantDetailAfterAiBody).includes(masterGeminiKey)
        && merchantRejectedMasterAi.status === 403,
      'Master Admin can assign encrypted provider credentials to a store without exposing them'
    );
    const masterClearedAi = await fetch(`${origin}/api/master-admin/stores/${storeId}/ai-settings`, {
      method: 'POST',
      headers: { Cookie: masterCookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', clearOpenaiApiKey: true, clearGeminiApiKey: true })
    });
    const masterClearedAiBody = await masterClearedAi.json() as any;
    const remainingMasterAiKeys = (db.prepare("SELECT COUNT(*) AS count FROM settings WHERE store_id = ? AND key IN ('ai_api_key', 'openai_api_key', 'gemini_api_key')").get(storeId) as any)?.count;
    assert(
      masterClearedAi.ok
        && masterClearedAiBody.aiSettings?.openaiConfigured === false
        && masterClearedAiBody.aiSettings?.geminiConfigured === false
        && remainingMasterAiKeys === 0,
      'Master Admin can delete stored AI credentials including the active provider key'
    );
    db.prepare("DELETE FROM settings WHERE store_id = ? AND key = 'ai_provider'").run(storeId);
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

    const storeAiKey = 'AIza-http-store-isolated-123456789012345';
    const savedAiProvider = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'gemini' }, aiApiKey: storeAiKey })
    });
    const aiSettingsResponse = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const aiSettingsBody = await aiSettingsResponse.json() as any;
    const storedAiSecret = (db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'gemini_api_key'").get(storeId) as any)?.value || '';
    assert(
      savedAiProvider.ok
        && aiSettingsBody.settings.ai_provider === 'gemini'
        && aiSettingsBody.settings.ai_api_key_configured === '1'
        && !JSON.stringify(aiSettingsBody).includes(storeAiKey)
        && storedAiSecret.startsWith('sv1:')
        && storedAiSecret !== storeAiKey,
      'Store AI provider and encrypted API key can be configured without exposing the secret'
    );

    const rejectedProviderOnlyChange = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'openai' } })
    });
    const providerAfterRejectedChange = (db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'ai_provider'").get(storeId) as any)?.value;
    const secretAfterRejectedChange = (db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'gemini_api_key'").get(storeId) as any)?.value;
    assert(
      rejectedProviderOnlyChange.status === 400
        && providerAfterRejectedChange === 'gemini'
        && secretAfterRejectedChange === storedAiSecret,
      'Changing AI provider without its new key is rejected atomically and preserves the saved configuration'
    );

    const rejectedMismatchedKey = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'openai' }, aiApiKey: 'AIza-wrong-provider-key-123456789012345' })
    });
    const providerAfterMismatchedKey = (db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'ai_provider'").get(storeId) as any)?.value;
    const secretAfterMismatchedKey = (db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'gemini_api_key'").get(storeId) as any)?.value;
    assert(
      rejectedMismatchedKey.status === 400
        && providerAfterMismatchedKey === 'gemini'
        && secretAfterMismatchedKey === storedAiSecret,
      'Provider and API key type mismatch is rejected without changing the saved credential'
    );

    const savedOpenAiKey = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'openai' }, aiApiKey: 'sk-http-openai-saved-12345678901234567890' })
    });
    const switchedBackToGemini = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'gemini' } })
    });
    const switchedAgainToOpenAi = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { ai_provider: 'openai' } })
    });
    const dualProviderSettings = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const dualProviderBody = await dualProviderSettings.json() as any;
    assert(
      savedOpenAiKey.ok
        && switchedBackToGemini.ok
        && switchedAgainToOpenAi.ok
        && dualProviderBody.settings.ai_provider === 'openai'
        && dualProviderBody.settings.openai_api_key_configured === '1'
        && dualProviderBody.settings.gemini_api_key_configured === '1',
      'Saved OpenAI and Gemini credentials can be selected repeatedly without entering either key again'
    );

    const autoVipSetting = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'auto_vip_reward_enabled', value: '1' })
    });
    const refreshedSettings = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
    const refreshedSettingsBody = await refreshedSettings.json() as any;
    assert(
      autoVipSetting.ok && refreshedSettingsBody.settings.auto_vip_reward_enabled === '1',
      'Automatic VIP reward setting can be saved and read by the merchant panel'
    );

    const savedHandoffSettings = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { human_handoff_enabled: '1', human_handoff_minutes: '30' } })
    });
    const handoffConversationId = Number(db.prepare(`
      INSERT INTO conversations (store_id, external_user_id, status, standby_until, standby_reason, standby_started_at)
      VALUES (?, 'instagram:http_handoff_customer', 'standby', datetime('now', '+30 minutes'), 'owner_message', CURRENT_TIMESTAMP)
    `).run(storeId).lastInsertRowid);
    const foreignHandoffConversationId = Number(db.prepare(`
      INSERT INTO conversations (store_id, external_user_id, status, standby_until, standby_reason, standby_started_at)
      VALUES (1, 'instagram:foreign_handoff_customer', 'standby', datetime('now', '+30 minutes'), 'owner_message', CURRENT_TIMESTAMP)
    `).run().lastInsertRowid);
    const handoffList = await fetch(`${origin}/api/human-handoff/conversations`, { headers: { Cookie: cookie } });
    const handoffListBody = await handoffList.json() as any;
    const rejectedForeignResume = await fetch(`${origin}/api/human-handoff/conversations/${foreignHandoffConversationId}/resume`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin }
    });
    const resumedOwnConversation = await fetch(`${origin}/api/human-handoff/conversations/${handoffConversationId}/resume`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin }
    });
    const resumedOwnStatus = (db.prepare('SELECT status FROM conversations WHERE id = ?').get(handoffConversationId) as any)?.status;
    assert(
      savedHandoffSettings.ok
        && handoffList.ok
        && handoffListBody.config?.enabled === true
        && handoffListBody.config?.minutes === 30
        && handoffListBody.conversations?.some((conversation: any) => conversation.id === handoffConversationId)
        && rejectedForeignResume.status === 404
        && resumedOwnConversation.ok
        && resumedOwnStatus === 'active',
      'Merchant can configure handoff, list only tenant standby conversations and manually resume AI'
    );
    db.prepare("UPDATE conversations SET status = 'standby', standby_until = datetime('now', '+30 minutes'), standby_reason = 'owner_message' WHERE id = ?").run(handoffConversationId);
    const disabledHandoff = await fetch(`${origin}/api/settings`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { human_handoff_enabled: '0' } })
    });
    const disabledOwnHandoffStatus = (db.prepare('SELECT status FROM conversations WHERE id = ?').get(handoffConversationId) as any)?.status;
    const foreignHandoffStatus = (db.prepare('SELECT status FROM conversations WHERE id = ?').get(foreignHandoffConversationId) as any)?.status;
    assert(disabledHandoff.ok && disabledOwnHandoffStatus === 'active' && foreignHandoffStatus === 'standby', 'Disabling handoff clears only the authenticated store standby state');
    db.prepare('DELETE FROM messages WHERE conversation_id IN (?, ?)').run(handoffConversationId, foreignHandoffConversationId);
    db.prepare('DELETE FROM conversations WHERE id IN (?, ?)').run(handoffConversationId, foreignHandoffConversationId);

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
    db.prepare('DELETE FROM merchant_applications WHERE email = ?').run(email);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
