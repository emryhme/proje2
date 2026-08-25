// ISCWORKS Admin Control Panel Application Logic

const API_BASE = '';
const POLL_INTERVAL_MS = 10000; // 10 Saniyede Bir Arka Plan Kontrolü (Ultra Hafif)

// HTML Escaping Utility for XSS Prevention
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Central Safe API Wrapper. The session token stays in an HttpOnly cookie.
async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  try {
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });

    if (response.status === 401) {
      localStorage.removeItem('barons_admin_token');
      localStorage.removeItem('barons_admin_user');
      if (!window.location.pathname.endsWith('login')) {
        showToast('🔑 Oturumunuzun süresi doldu. Giriş sayfasına yönlendiriliyorsunuz...', 'warning');
        setTimeout(() => { window.location.href = 'login'; }, 800);
      }
      throw new Error('UNAUTHORIZED');
    }

    if (response.status === 403) {
      showToast('⛔ Bu işlem için yetkiniz bulunmamaktadır.', 'error');
      throw new Error('FORBIDDEN');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = typeof data.error === 'string' ? data.error : (data.error?.message || 'İşlem başarısız.');
      throw new Error(errMsg);
    }
    return data;
  } catch (err) {
    if (err.message !== 'UNAUTHORIZED' && err.message !== 'FORBIDDEN') {
      console.warn('[apiFetch Notice]:', err.message);
    }
    throw err;
  }
}

// Global App State
const state = {
  products: [],
  orders: [],
  rewards: [],
  knownOrderIds: new Set(),
  searchQuery: '',
  soundEnabled: true,
  isInitialLoad: true,
  isFetching: false
};

const THEME_STORAGE_KEY = 'iscworks_admin_theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const button = document.getElementById('themeToggle');
  if (button) {
    const isLight = theme === 'light';
    button.setAttribute('aria-label', isLight ? 'Koyu moda geç' : 'Açık moda geç');
    button.title = isLight ? 'Koyu moda geç' : 'Açık moda geç';
    button.innerHTML = `<i data-lucide="${isLight ? 'moon' : 'sun'}" size="17"></i>`;
    if (window.lucide) lucide.createIcons();
  }
}

function setupThemeToggle() {
  const actions = document.querySelector('.top-actions');
  if (!actions || document.getElementById('themeToggle')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button theme-toggle';
  button.id = 'themeToggle';
  button.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  actions.prepend(button);
  applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'dark');
}

function applyDynamicStoreBranding() {
  const rawUser = localStorage.getItem('barons_admin_user');
  let storeName = 'ISCWORKS';
  if (rawUser) {
    try {
      const u = JSON.parse(rawUser);
      storeName = u.storeName || u.title || 'Mağazam';
    } catch (e) {}
  }
  document.title = `${storeName} — Admin Panel`;

  const storeAvatar = document.querySelector('.store-avatar');
  const storeTitle = document.querySelector('.store-info strong');
  const storeSubtitle = document.querySelector('.store-info small');
  const initials = storeName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'MA';
  if (storeAvatar) storeAvatar.textContent = initials;
  if (storeTitle) storeTitle.textContent = storeName;
  if (storeSubtitle) storeSubtitle.textContent = 'Mağaza kontrol paneli';
}

function applyCurrentUserProfile() {
  const rawUser = localStorage.getItem('barons_admin_user');
  let displayName = 'Kullanıcı';
  let role = 'OWNER';

  if (rawUser) {
    try {
      const user = JSON.parse(rawUser);
      displayName = user.name || user.email || displayName;
      role = user.role || role;
    } catch (error) {
      // checkAuthStatus redirects when a valid user session is not available.
    }
  }

  const roleLabels = {
    OWNER: 'Mağaza Sahibi',
    ADMIN: 'Mağaza Yöneticisi',
    MANAGER: 'Mağaza Müdürü',
    STAFF: 'Mağaza Personeli'
  };
  const initials = String(displayName).split(/\s+|@/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'KU';
  const avatar = document.querySelector('.user .avatar');
  const nameElement = document.querySelector('.user-text strong');
  const roleElement = document.querySelector('.user-text span');
  const brand = document.querySelector('.logo');
  let ownerNameElement = brand?.querySelector('.admin-owner-name') || brand?.querySelector('span');
  let storeLabel = 'Mağazam';

  if (rawUser) {
    try {
      const user = JSON.parse(rawUser);
      storeLabel = user.storeName || user.title || storeLabel;
    } catch (error) {
      // A valid session is handled by checkAuthStatus.
    }
  }

  brand?.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) node.remove();
  });

  if (!ownerNameElement && brand) {
    ownerNameElement = document.createElement('span');
    brand.appendChild(ownerNameElement);
  }

  if (avatar) avatar.textContent = initials;
  if (nameElement) nameElement.textContent = displayName;
  if (roleElement) roleElement.textContent = roleLabels[role] || role;
  if (ownerNameElement) {
    ownerNameElement.className = 'admin-owner-name';
    ownerNameElement.textContent = storeLabel;
  }
}

async function checkAuthStatus() {
  const path = window.location.pathname;
  if (path.endsWith('login')) return;
  try {
    const response = await fetch('/api/auth/verify', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('UNAUTHORIZED');
  } catch {
    localStorage.removeItem('barons_admin_user');
    window.location.href = 'login';
  }
}

async function logoutUser() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  localStorage.removeItem('barons_admin_token');
  localStorage.removeItem('barons_admin_user');
  state.products = [];
  state.orders = [];
  state.rewards = [];
  state.knownOrderIds.clear();
  showToast('👋 Çıkış yapıldı. Ana sayfaya yönlendiriliyorsunuz...', 'info');
  setTimeout(() => {
    window.location.href = 'https://www.iscworks.info/';
  }, 600);
}

function ensurePlanNavigation() {
  if (document.querySelector('.nav-item[href="plan"]')) return;
  const apiSettingsLink = document.querySelector('.nav-item[href="api-settings"]');
  if (!apiSettingsLink) return;
  const link = document.createElement('a');
  link.href = 'plan';
  link.className = `nav-item${window.location.pathname.endsWith('/plan') ? ' active' : ''}`;
  link.innerHTML = '<i data-lucide="credit-card"></i>Plan Yönetimi';
  apiSettingsLink.before(link);
}

function ensureDashboardStockNavigation() {
  const dashboardLink = document.querySelector('.nav-item[href="dashboard"]');
  if (!dashboardLink) return;

  dashboardLink.innerHTML = '<i data-lucide="layout-dashboard"></i>Dashboard';
  dashboardLink.classList.toggle('active', window.location.pathname.endsWith('/dashboard') || window.location.pathname.endsWith('/admin/'));

  let stockLink = document.querySelector('.nav-item[href="stock"]');
  if (!stockLink) {
    stockLink = document.createElement('a');
    stockLink.href = 'stock';
    stockLink.className = 'nav-item';
    stockLink.innerHTML = '<i data-lucide="package-search"></i>Stok Yönetimi';
    dashboardLink.after(stockLink);
  }
  stockLink.classList.toggle('active', window.location.pathname.endsWith('/stock'));
}

function ensureDataSourcesNavigation() {
  if (document.querySelector('.nav-item[href="data-sources"]')) return;
  const apiSettingsLink = document.querySelector('.nav-item[href="api-settings"]');
  if (!apiSettingsLink) return;
  const link = document.createElement('a');
  link.href = 'data-sources';
  link.className = `nav-item${window.location.pathname.endsWith('/data-sources') ? ' active' : ''}`;
  link.innerHTML = '<i data-lucide="database-zap"></i>Veri Kaynakları';
  apiSettingsLink.before(link);
}

function ensureInstagramMediaNavigation() {
  if (document.querySelector('.nav-item[href="instagram-media"]')) return;
  const dataSourcesLink = document.querySelector('.nav-item[href="data-sources"]');
  const apiSettingsLink = document.querySelector('.nav-item[href="api-settings"]');
  const anchor = dataSourcesLink || apiSettingsLink;
  if (!anchor) return;
  const link = document.createElement('a');
  link.href = 'instagram-media';
  link.className = `nav-item${window.location.pathname.endsWith('/instagram-media') ? ' active' : ''}`;
  link.innerHTML = '<i data-lucide="images"></i>Instagram Gönderileri';
  anchor.before(link);
}

function formatPlanDate(value) {
  if (!value) return 'Tanımlanmadı';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
}

let planInfoRequest = null;

function getPlanInfo() {
  if (!planInfoRequest) {
    planInfoRequest = apiFetch('/api/plan').catch(error => {
      planInfoRequest = null;
      throw error;
    });
  }
  return planInfoRequest;
}

function isPlanExpired(subscription) {
  if (!subscription?.ends_at) return false;
  if (Number.isFinite(Number(subscription.remaining_days))) return Number(subscription.remaining_days) < 0;
  return String(subscription.ends_at).slice(0, 10) < new Date().toISOString().slice(0, 10);
}

function renderPlanExpiryBanner(subscription) {
  document.getElementById('planExpiryBanner')?.remove();
  if (!isPlanExpired(subscription)) return;
  const main = document.querySelector('main.main');
  const topbar = main?.querySelector(':scope > .topbar');
  if (!main || !topbar) return;

  const banner = document.createElement('div');
  banner.id = 'planExpiryBanner';
  banner.className = 'plan-expiry-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <div class="plan-expiry-message">
      <i data-lucide="triangle-alert" aria-hidden="true"></i>
      <div><strong>Planınız sona erdi.</strong><span>Kesintiye uğramamak için yenileme yapınız.</span></div>
    </div>
    <a class="plan-expiry-action" href="plan">Planı Yenile</a>
  `;
  topbar.insertAdjacentElement('afterend', banner);
  if (window.lucide) lucide.createIcons();
}

async function loadPlanExpiryBanner() {
  try {
    const data = await getPlanInfo();
    renderPlanExpiryBanner(data.subscription);
  } catch (error) {
    if (!['UNAUTHORIZED', 'FORBIDDEN'].includes(error.message)) {
      console.warn('[Plan Notice]:', error.message);
    }
  }
}

async function loadPlanManagement() {
  if (!document.getElementById('planName')) return;
  try {
    const data = await getPlanInfo();
    const plan = data.subscription;
    const select = document.getElementById('requestedPlan');
    if (select) {
      select.innerHTML = '<option value="">Plan seçin</option>' + (data.allowedPlans || []).map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    }
    if (!plan) {
      document.getElementById('planName').textContent = 'Plan süresi tanımlanmadı';
      document.getElementById('planProgressText').textContent = 'Süper Admin plan dönemi tanımlamalı';
      renderPlanRequests(data.requests || []);
      return;
    }

    document.getElementById('planName').textContent = plan.plan_name;
    document.getElementById('planMonths').textContent = `${plan.duration_months} ay · ${plan.duration_days || 0} gün`;
    document.getElementById('planStartsAt').textContent = formatPlanDate(plan.starts_at);
    document.getElementById('planEndsAt').textContent = formatPlanDate(plan.ends_at);
    const start = new Date(`${String(plan.starts_at).slice(0, 10)}T00:00:00`).getTime();
    const end = new Date(`${String(plan.ends_at).slice(0, 10)}T00:00:00`).getTime();
    const now = Date.now();
    const progress = end > start ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : 0;
    document.getElementById('planProgressFill').style.width = `${progress}%`;
    document.getElementById('planProgressText').textContent = `%${Math.round(progress)} kullanıldı`;
    const remaining = Number(plan.remaining_days);
    document.getElementById('planRemainingDays').textContent = remaining >= 0 ? `${remaining} gün kaldı` : `${Math.abs(remaining)} gün önce sona erdi`;
    renderPlanRequests(data.requests || []);
  } catch (error) {
    showToast(error.message || 'Plan bilgileri yüklenemedi.', 'error');
  }
}

function renderPlanRequests(requests) {
  const container = document.getElementById('planRequests');
  if (!container) return;
  const statusLabels = { open: 'İnceleniyor', resolved: 'Yanıtlandı', rejected: 'Reddedildi' };
  container.innerHTML = requests.length ? requests.map(request => `
    <div class="request-item">
      <div class="request-top"><span class="request-route">${escapeHtml(request.current_plan)} → ${escapeHtml(request.requested_plan)}</span><span class="plan-status ${escapeHtml(request.status)}">${statusLabels[request.status] || escapeHtml(request.status)}</span></div>
      <div class="request-meta">${formatPlanDate(request.created_at)}</div>
      <div class="request-message">${escapeHtml(request.message)}</div>
      ${request.admin_note ? `<div class="request-message" style="color:#34d399"><strong>Destek yanıtı:</strong> ${escapeHtml(request.admin_note)}</div>` : ''}
    </div>`).join('') : '<div class="plan-empty">Henüz plan destek talebiniz bulunmuyor.</div>';
}

async function submitPlanSupportRequest(event) {
  event.preventDefault();
  const button = document.getElementById('planRequestButton');
  button.disabled = true;
  try {
    const data = await apiFetch('/api/plan/support-requests', {
      method: 'POST',
      body: JSON.stringify({ requestedPlan: document.getElementById('requestedPlan').value, message: document.getElementById('planRequestMessage').value.trim() })
    });
    showToast(data.message, 'success');
    event.target.reset();
    await loadPlanManagement();
  } catch (error) {
    showToast(error.message || 'Destek talebi açılamadı.', 'error');
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  ensurePlanNavigation();
  document.getElementById('planSupportForm')?.addEventListener('submit', submitPlanSupportRequest);
  loadPlanManagement();
  if (window.lucide) lucide.createIcons();
});

function setupUserDropdown() {
  const userElem = document.querySelector('.user');
  if (!userElem) return;

  userElem.style.cursor = 'pointer';
  userElem.style.position = 'relative';

  const rawUser = localStorage.getItem('barons_admin_user');
  let displayName = 'Kullanıcı';
  let roleTitle = 'OWNER';
  if (rawUser) {
    try {
      const u = JSON.parse(rawUser);
      displayName = u.name || u.email || 'Kullanıcı';
      roleTitle = u.role || u.title || 'OWNER';
    } catch (e) {}
  }

  const roleDisplayLabels = {
    OWNER: 'Mağaza Sahibi',
    ADMIN: 'Yönetici',
    MANAGER: 'Mağaza Müdürü',
    STAFF: 'Mağaza Personeli'
  };
  roleTitle = roleDisplayLabels[roleTitle] || roleTitle;

  let dropdown = document.getElementById('userProfileDropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'userProfileDropdown';
    dropdown.style.cssText = `
      position: absolute; top: 50px; right: 0; width: 220px;
      background: #ffffff; border: 1px solid #e5e7eb; border-radius: 10px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.1); display: none; flex-direction: column;
      padding: 8px 0; z-index: 9999; animation: modalFadeIn 0.2s ease;
    `;
    dropdown.innerHTML = `
      <div style="padding: 10px 16px; border-bottom: 1px solid #f0f0f0;">
        <strong style="font-size: 12px; display: block; color: #111827;">${escapeHtml(displayName)}</strong>
        <span style="font-size: 10px; color: #6b7280; font-weight: 600;">Rol: ${escapeHtml(roleTitle)}</span>
      </div>
      <div onclick="logoutUser()" style="padding: 10px 16px; font-size: 11px; color: #ef4444; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px;" onmouseover="this.style.background='#fef2f2'" onmouseout="this.style.background='transparent'">
        <i class="fa-solid fa-right-from-bracket"></i> Çıkış Yap
      </div>
    `;
    userElem.appendChild(dropdown);
  }

  userElem.onclick = (e) => {
    e.stopPropagation();
    dropdown.style.display = (dropdown.style.display === 'flex') ? 'none' : 'flex';
  };

  document.addEventListener('click', () => {
    dropdown.style.display = 'none';
  });
}

// Initialize Application Robustly (Supports readyState interactive & complete)
function initApp() {
  checkAuthStatus();
  ensureDashboardStockNavigation();
  ensurePlanNavigation();
  ensureDataSourcesNavigation();
  ensureInstagramMediaNavigation();
  loadPlanExpiryBanner();
  setupThemeToggle();
  applyDynamicStoreBranding();
  applyCurrentUserProfile();
  setupEventListeners();
  setupUserDropdown();
  fetchData();
  fetchCampaigns();
  fetchSettings();
  fetchMerchantApplications();
  initializeDataSourcesPage();
  initializeInstagramMediaPage();
  initializeStockAlertCards();
  setInterval(pollOrdersInBackground, POLL_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Setup Event Listeners (Dinamik DOM Seçiciler)
function setupEventListeners() {
  const btnRefreshData = document.getElementById('btnRefreshData');
  const btnToggleSound = document.getElementById('btnToggleSound');
  const searchInput = document.getElementById('searchInput');
  const shortCode = document.getElementById('shortCode');
  const sizeInput = document.getElementById('sizeInput');
  const autoCodePreview = document.getElementById('autoCodePreview');
  const productCode = document.getElementById('productCode');
  const newProductForm = document.getElementById('newProductForm');
  const btnSubmitAiProduct = document.getElementById('btnSubmitAiProduct');
  const settingsForm = document.getElementById('settingsForm');
  const campaignForm = document.getElementById('campaignForm');

  if (btnRefreshData) {
    btnRefreshData.addEventListener('click', () => {
      showToast('🔄 Veriler tazeleniyor...', 'info');
      fetchData();
      fetchCampaigns();
      fetchSettings();
    });
  }

  if (btnToggleSound) {
    btnToggleSound.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      const icon = btnToggleSound.querySelector('i');
      if (state.soundEnabled) {
        if (icon) icon.className = 'fa-solid fa-bell text-gold';
        showToast('🔔 Sesli sipariş bildirimleri açıldı.', 'success');
        playNotificationSound('preview');
        if ('Notification' in window && Notification.permission !== 'granted') {
          Notification.requestPermission();
        }
      } else {
        if (icon) icon.className = 'fa-solid fa-bell-slash text-muted';
        showToast('🔕 Sesli sipariş bildirimleri sessize alındı.', 'info');
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderTables();
    });
  }

  if (shortCode && sizeInput && autoCodePreview) {
    const updateCodePreview = () => {
      const sc = (shortCode.value || 'KGMLW').toUpperCase().trim();
      const sz = (sizeInput.value || 'M').toUpperCase().trim();
      const computedCode = `${sc}-${sz}`;
      autoCodePreview.textContent = `Önizleme: ${computedCode}`;
      if (productCode && !productCode.value) {
        productCode.placeholder = `Örn: ${computedCode}`;
      }
    };

    shortCode.addEventListener('input', updateCodePreview);
    sizeInput.addEventListener('input', updateCodePreview);
  }

  if (newProductForm) {
    newProductForm.addEventListener('submit', handleNewProductSubmit);
  }

  if (btnSubmitAiProduct) {
    btnSubmitAiProduct.addEventListener('click', handleAiProductSubmit);
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', handleSettingsSubmit);
  }

  if (campaignForm) {
    campaignForm.addEventListener('submit', handleCampaignSubmit);
  }

  const rewardForm = document.getElementById('rewardForm');
  if (rewardForm) {
    rewardForm.addEventListener('submit', handleRewardSubmit);
  }

  const btnSendAdminChat = document.getElementById('btnSendAdminChat');
  const aiAdminChatInput = document.getElementById('aiAdminChatInput');

  if (btnSendAdminChat) {
    btnSendAdminChat.addEventListener('click', sendAdminChatMessage);
  }

  if (aiAdminChatInput) {
    aiAdminChatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAdminChatMessage();
      }
    });
  }

  const btnToggleAutoReward = document.getElementById('btnToggleAutoReward');
  if (btnToggleAutoReward) {
    btnToggleAutoReward.addEventListener('click', toggleAutoRewardSetting);
  }
}

// Tarayıcıda dosya indirmeden çalışan, yüksek ve çok tonlu bildirim alarmı.
let notificationAudioContext = null;

function playNotificationSound(type = 'order') {
  if (!state.soundEnabled) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    notificationAudioContext ||= new AudioContextClass();
    const audioCtx = notificationAudioContext;
    const notes = type === 'preview'
      ? [
          { frequency: 659.25, delay: 0, duration: 0.18, volume: 0.72 },
          { frequency: 880, delay: 0.16, duration: 0.28, volume: 0.82 }
        ]
      : [
          { frequency: 659.25, delay: 0, duration: 0.24, volume: 0.78 },
          { frequency: 783.99, delay: 0.18, duration: 0.24, volume: 0.82 },
          { frequency: 987.77, delay: 0.36, duration: 0.38, volume: 0.92 },
          { frequency: 783.99, delay: 0.82, duration: 0.24, volume: 0.82 },
          { frequency: 987.77, delay: 1, duration: 0.48, volume: 0.96 }
        ];

    const scheduleAlarm = () => {
      const masterGain = audioCtx.createGain();
      const compressor = audioCtx.createDynamicsCompressor();
      masterGain.gain.setValueAtTime(0.9, audioCtx.currentTime);
      compressor.threshold.setValueAtTime(-18, audioCtx.currentTime);
      compressor.knee.setValueAtTime(18, audioCtx.currentTime);
      compressor.ratio.setValueAtTime(8, audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressor.release.setValueAtTime(0.2, audioCtx.currentTime);
      masterGain.connect(compressor);
      compressor.connect(audioCtx.destination);

      notes.forEach(({ frequency, delay, duration, volume }) => {
        const startAt = audioCtx.currentTime + 0.03 + delay;
        const stopAt = startAt + duration;
        const noteGain = audioCtx.createGain();
        const mainOscillator = audioCtx.createOscillator();
        const sparkleOscillator = audioCtx.createOscillator();

        mainOscillator.type = 'triangle';
        mainOscillator.frequency.setValueAtTime(frequency, startAt);
        sparkleOscillator.type = 'sine';
        sparkleOscillator.frequency.setValueAtTime(frequency * 2, startAt);

        noteGain.gain.setValueAtTime(0.0001, startAt);
        noteGain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
        noteGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        mainOscillator.connect(noteGain);
        sparkleOscillator.connect(noteGain);
        noteGain.connect(masterGain);
        mainOscillator.start(startAt);
        sparkleOscillator.start(startAt);
        mainOscillator.stop(stopAt);
        sparkleOscillator.stop(stopAt);
      });
    };

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(scheduleAlarm).catch((error) => {
        console.warn('Audio resume error:', error);
      });
    } else {
      scheduleAlarm();
    }
  } catch (e) {
    console.warn('Audio sound error:', e);
  }
}

function playNewOrderSound() {
  playNotificationSound('order');
}

function triggerDesktopNotification(order) {
  if (!('Notification' in window)) return;
  try {
    if (Notification.permission === 'granted') {
      new Notification('🔔 YENİ SİPARİŞ DÜŞTÜ!', {
        body: `Müşteri: ${order.customerName || 'Bilinmiyor'}\nÜrün: ${order.productCode || ''} (${order.quantity || 1} Adet)\nToplam: ${order.totalPrice || 0} TL`,
        icon: '/favicon.ico'
      });
    }
  } catch (e) {
    console.warn('Desktop notification error:', e);
  }
}

// Fetch Products & Orders from Backend API
async function fetchData() {
  if (state.isFetching) return;
  state.isFetching = true;
  setSyncStatus('loading', 'Senkronize Ediliyor...');

  try {
    const [stocksRes, ordersRes, rewardsRes] = await Promise.all([
      apiFetch('/api/stocks').catch(() => null),
      apiFetch('/api/orders').catch(() => null),
      apiFetch('/api/rewards').catch(() => null)
    ]);

    if (stocksRes && Array.isArray(stocksRes.stocks)) {
      state.products = stocksRes.stocks;
    }
    if (ordersRes && Array.isArray(ordersRes.orders)) {
      processIncomingOrders(ordersRes.orders);
    }
    if (rewardsRes && Array.isArray(rewardsRes.rewards)) {
      state.rewards = rewardsRes.rewards;
    }

    state.isInitialLoad = false;
    updateMetrics();
    renderTables();
    loadAutoRewardSetting();
    await updateInstagramConnectionStatus();

  } catch (error) {
    console.error('Fetch error:', error);
    setSyncStatus('error', 'Senkronizasyon Duraklatıldı');
    renderTables();
  } finally {
    state.isFetching = false;
  }
}

// Arka Planda Sessiz ve Ultra Hızlı Canlı Sipariş Kontrolü (Polling)
async function pollOrdersInBackground() {
  try {
    const data = await apiFetch('/api/orders');
    if (data && data.success && Array.isArray(data.orders)) {
      const newOrdersDetected = processIncomingOrders(data.orders);
      if (newOrdersDetected) {
        updateMetrics();
        renderTables();
      }
    }
  } catch (e) {
    // Silent background poll
  }
}

// Sipariş İşleme & Yeni Sipariş Bildirim Alarmı
function processIncomingOrders(newOrdersList) {
  let hasNew = false;

  for (const order of newOrdersList) {
    if (order.orderId && !state.knownOrderIds.has(order.orderId)) {
      state.knownOrderIds.add(order.orderId);

      if (!state.isInitialLoad) {
        hasNew = true;
        playNewOrderSound();
        triggerDesktopNotification(order);
        showToast(`🔔 YENİ SİPARİŞ DÜŞTÜ!\n👤 ${order.customerName} - 📦 ${order.productCode} (${order.quantity} Adet)`, 'success');
      }
    }
  }

  state.orders = newOrdersList;
  return hasNew;
}

function getFilteredOrders() {
  return state.orders || [];
}

// Update Top Metric Cards & Real Analytics (Mağaza Özel Dinamik Hesaplama)
function updateMetrics() {
  const currentProducts = getStoreProducts();
  const currentOrders = getFilteredOrders();

  const totalProducts = currentProducts.length;
  const totalStock = currentProducts.reduce((acc, p) => acc + (Number(p.stock) || 0), 0);
  const totalOrders = currentOrders.length;
  const lowStockProducts = currentProducts.filter(p => Number(p.stock) > 0 && Number(p.stock) <= 5).length;
  const outOfStockProducts = currentProducts.filter(p => Number(p.stock) <= 0).length;

  const statTotalProducts = document.getElementById('statTotalProducts');
  const statTotalStock = document.getElementById('statTotalStock');
  const statTotalOrders = document.getElementById('statTotalOrders');
  const statLowStock = document.getElementById('statLowStock');
  const statOutOfStock = document.getElementById('statOutOfStock');
  const ordersBadgeCount = document.getElementById('ordersBadgeCount');

  if (statTotalProducts) statTotalProducts.textContent = totalProducts.toLocaleString('tr-TR');
  if (statTotalStock) statTotalStock.textContent = totalStock.toLocaleString('tr-TR');
  if (statTotalOrders) statTotalOrders.textContent = totalOrders.toLocaleString('tr-TR');
  if (statLowStock) statLowStock.textContent = lowStockProducts.toLocaleString('tr-TR');
  if (statOutOfStock) statOutOfStock.textContent = outOfStockProducts.toLocaleString('tr-TR');
  if (ordersBadgeCount) ordersBadgeCount.textContent = totalOrders;

  // AI Asistan Kartı - sabit
  const metricCards = document.querySelectorAll('.metric-card');
  if (metricCards.length >= 4) {
    const aiValElem = metricCards[3].querySelector('.metric-value');
    const aiSubElem = metricCards[3].querySelector('.metric-sub');
    if (aiValElem) aiValElem.textContent = 'S.E.T.T';
    if (aiSubElem) aiSubElem.textContent = 'Yönetici Asistanı';
  }

  // 1. Gerçek Ciro ve Sipariş Trendi Çizgi Grafiğini Çiz
  renderRevenueTrendLineChart();

  // 2. Gerçek En Çok Satılan Ürünler (Top 5) Sıralamasını Çiz
  renderTopProductsRankingList();
}

function closeStockAlertModal() {
  document.getElementById('stockAlertModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function openStockAlertModal(type) {
  const modal = document.getElementById('stockAlertModal');
  const body = document.getElementById('stockAlertTableBody');
  if (!modal || !body) return;
  const isCritical = type === 'critical';
  const products = getStoreProducts()
    .filter(product => {
      const stock = Number(product.stock) || 0;
      return isCritical ? stock >= 1 && stock <= 5 : stock <= 0;
    })
    .sort((a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0) || String(a.productCode || '').localeCompare(String(b.productCode || ''), 'tr'));

  document.getElementById('stockAlertTitle').textContent = isCritical ? 'Kritik Stoktaki Ürünler' : 'Tükenen Ürünler';
  document.getElementById('stockAlertSubtitle').textContent = isCritical
    ? 'Stok adedi 1 ile 5 arasında kalan ürünler'
    : 'Stok adedi sıfır olan ürünler';
  document.getElementById('stockAlertDescription').textContent = isCritical
    ? 'Bu ürünler için stok takviyesi planlayabilirsiniz.'
    : 'Bu ürünler şu anda satışa uygun stok bulundurmuyor.';
  document.getElementById('stockAlertCount').textContent = `${products.length} ürün`;

  body.innerHTML = products.length ? products.map(product => {
    const stock = Number(product.stock) || 0;
    return `<tr>
      <td><span class="code-tag">${escapeHtml(product.productCode || product.shortCode || '-')}</span></td>
      <td><strong>${escapeHtml(product.name || '-')}</strong></td>
      <td><span class="size-pill">${escapeHtml(product.size || '-')}</span></td>
      <td class="optional-column">${escapeHtml(product.color || '-')}</td>
      <td><span class="stock-alert-stock${stock <= 0 ? ' empty' : ''}">${stock}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5"><div class="stock-alert-empty"><i data-lucide="circle-check" size="28"></i><div>${isCritical ? 'Kritik stokta ürün bulunmuyor.' : 'Tükenen ürün bulunmuyor.'}</div></div></td></tr>`;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (window.lucide) lucide.createIcons();
}

function initializeStockAlertCards() {
  const lowStockCard = document.getElementById('lowStockKpi');
  const outOfStockCard = document.getElementById('outOfStockKpi');
  const bindCard = (card, type) => {
    if (!card) return;
    card.addEventListener('click', () => openStockAlertModal(type));
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openStockAlertModal(type);
    });
  };
  bindCard(lowStockCard, 'critical');
  bindCard(outOfStockCard, 'empty');
  document.getElementById('btnCloseStockAlert')?.addEventListener('click', closeStockAlertModal);
  document.getElementById('stockAlertModal')?.addEventListener('click', event => {
    if (event.target.id === 'stockAlertModal') closeStockAlertModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('stockAlertModal')?.classList.contains('open')) closeStockAlertModal();
  });
}

let revenueTrendChartInstance = null;

function renderRevenueTrendLineChart() {
  const ctx = document.getElementById('revenueTrendChart');
  if (!ctx) return;

  const orders = state.orders || [];
  const dailyRevenueMap = {};

  orders.forEach(o => {
    let dateStr = 'Bugün';
    if (o.createdAt) {
      dateStr = String(o.createdAt).split('T')[0].split(' ')[0];
    }
    const qty = Number(o.quantity) || 1;
    const price = Number(o.totalPrice) || (qty * 299);

    if (!dailyRevenueMap[dateStr]) {
      dailyRevenueMap[dateStr] = 0;
    }
    dailyRevenueMap[dateStr] += price;
  });

  let labels = Object.keys(dailyRevenueMap);
  let revenues = Object.values(dailyRevenueMap);

  if (labels.length === 0) {
    labels = ['10 Ağu', '11 Ağu', '12 Ağu', '13 Ağu', '14 Ağu'];
    revenues = [0, 0, 0, 0, 0];
  }

  if (revenueTrendChartInstance) {
    revenueTrendChartInstance.destroy();
  }

  if (window.Chart) {
    revenueTrendChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Ciro (TL)',
          data: revenues,
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          backgroundColor: 'rgba(255, 153, 0, 0.1)',
          borderColor: '#ff9900',
          pointBackgroundColor: '#ff9900',
          pointRadius: 3,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                return ` Ciro: ₺${Number(context.raw).toLocaleString('tr-TR')}`;
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10, family: 'Inter' } } },
          y: {
            grid: { color: '#f0f0f0' },
            ticks: {
              font: { size: 10, family: 'Inter' },
              callback: function(value) { return '₺' + value.toLocaleString('tr-TR'); }
            }
          }
        }
      }
    });
  }
}

function renderTopProductsRankingList() {
  const topList = document.getElementById('topProductsList');
  if (!topList) return;

  const orders = state.orders || [];
  const productSalesMap = {};

  orders.forEach(o => {
    const code = (o.productCode || 'DİĞER').toUpperCase();
    const name = o.productName || code;
    const qty = Number(o.quantity) || 1;
    const price = Number(o.totalPrice) || (qty * 299);

    if (!productSalesMap[code]) {
      productSalesMap[code] = { code, name, qty: 0, revenue: 0 };
    }
    productSalesMap[code].qty += qty;
    productSalesMap[code].revenue += price;
  });

  const sortedProducts = Object.values(productSalesMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

  if (sortedProducts.length === 0) {
    topList.innerHTML = `
      <div style="text-align:center; padding:30px; color:#6b7280; font-size:12px;">
        Henüz verilmiş bir sipariş bulunmuyor.
      </div>
    `;
    return;
  }

  const maxQty = sortedProducts[0].qty || 1;

  topList.innerHTML = sortedProducts.map((p, index) => {
    const percent = Math.min(100, Math.round((p.qty / maxQty) * 100));
    const colors = ['#ff9900', '#3b82f6', '#10b981', '#a855f7', '#64748b'];
    const barColor = colors[index % colors.length];

    return `
      <div class="channel" style="margin-bottom:12px;">
          <div class="channel-icon" style="background:${barColor}15; color:${barColor}; font-weight:800; font-size:12px;">
              #${index + 1}
          </div>
          <div class="channel-info">
              <strong>${escapeHtml(p.code)} - ${escapeHtml(p.name)}</strong>
              <span>${p.qty} Adet Satıldı (₺${p.revenue.toLocaleString('tr-TR')} Ciro)</span>
              <div class="progress"><div style="width:${percent}%; background:${barColor};"></div></div>
          </div>
          <div class="channel-price" style="color:${barColor}; font-weight:700;">${p.qty} Adet</div>
      </div>
    `;
  }).join('');
}

// Render Products & Orders Tables
function renderTables() {
  const activeElem = document.activeElement;
  if (activeElem && (activeElem.tagName === 'INPUT' || activeElem.tagName === 'TEXTAREA') && activeElem.id.startsWith('price_')) {
    return;
  }

  renderProductsTable();
  renderOrdersTable();
  renderRewardsTable();
  renderRewardOrdersTable();

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (e) {}
  }
}

// Render VIP Sadakat Ödülleri Tablosu
function renderRewardsTable() {
  const rewardsTableBody = document.getElementById('rewardsTableBody');
  const rewardsTableCount = document.getElementById('rewardsTableCount');
  if (!rewardsTableBody) return;

  const rewards = state.rewards || [];
  if (rewardsTableCount) rewardsTableCount.textContent = `${rewards.length} Ödül Listelendi`;

  if (rewards.length === 0) {
    rewardsTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-cell">
          <i class="fa-solid fa-gift"></i> Henüz tanımlanmış bir VIP sadakat ödülü bulunmuyor. 2000 TL üzeri ilk siparişte otomatik oluşturulur!
        </td>
      </tr>
    `;
    return;
  }

  rewardsTableBody.innerHTML = rewards.map(r => {
    const isUsed = r.isUsed === 1;
    const statusBadge = isUsed 
      ? `<span class="status-badge out-stock">Kullanıldı</span>`
      : `<span class="status-badge in-stock">🚀 Aktif İndirim</span>`;

    return `
      <tr>
        <td>#${r.id}</td>
        <td><strong class="text-purple">${escapeHtml(r.senderId || '-')}</strong></td>
        <td><span class="code-tag">${escapeHtml(r.rewardCode || 'VIP20')}</span></td>
        <td><strong style="color:#4ade80;">%${r.discountPercent || 20} VIP İNDİRİM</strong></td>
        <td>${r.minQualifyingAmount || 2000} TL</td>
        <td>${statusBadge}</td>
        <td><small class="text-muted">${r.createdAt ? new Date(r.createdAt).toLocaleString('tr-TR') : '-'}</small></td>
        <td><small class="text-muted">${r.usedAt ? new Date(r.usedAt).toLocaleString('tr-TR') : '-'}</small></td>
        <td>
          <button class="btn btn-sm btn-delete" onclick="deleteReward(${r.id})">
            <i class="fa-solid fa-trash-can"></i> Sil
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Render VIP Sadakat Ekranındaki Sipariş Seçici Tablosu
function renderRewardOrdersTable() {
  const tableBody = document.getElementById('rewardOrdersTableBody');
  if (!tableBody) return;

  const orders = state.orders || [];
  if (orders.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-cell">
          <i class="fa-solid fa-inbox"></i> Henüz verilmiş bir sipariş bulunmuyor.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = orders.map(o => {
    const senderId = o.senderId || 'Bilinmiyor';
    const totalPriceNum = Number(o.totalPrice);
    const qty = Number(o.quantity) || 1;
    const fallbackPrice = qty * 299;

    let priceDisplay = `<strong class="text-green">${fallbackPrice.toFixed(2)} TL</strong>`;
    if (!isNaN(totalPriceNum) && totalPriceNum > 0) {
      priceDisplay = `<strong class="text-green">${totalPriceNum.toFixed(2)} TL</strong>`;
    }

    return `
      <tr style="cursor:pointer;" onclick="selectOrderForReward('${escapeHtml(senderId)}')">
        <td><strong class="text-purple">${escapeHtml(o.orderId || '-')}</strong></td>
        <td><span class="code-tag">${escapeHtml(senderId)}</span></td>
        <td><strong>${escapeHtml(o.customerName || '-')}</strong></td>
        <td>${escapeHtml(o.customerPhone || '-')}</td>
        <td>${priceDisplay}</td>
        <td><small class="text-muted">${escapeHtml(o.createdAt || '-')}</small></td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); selectOrderForReward('${escapeHtml(senderId)}')">
              <i class="fa-solid fa-hand-pointer"></i> Form'a Aktar
            </button>
            <button class="btn btn-sm btn-delete" onclick="event.stopPropagation(); deleteOrder('${escapeHtml(o.orderId)}')">
              <i class="fa-solid fa-trash"></i> Sil
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Sipariş Tıklandığında Müşteri ID'sini Sadakat Ödül Formuna Otomatik Doldur
function selectOrderForReward(senderId) {
  const senderInput = document.getElementById('rewardSenderId');
  const percentInput = document.getElementById('rewardPercent');
  const rewardForm = document.getElementById('rewardForm');

  if (!senderInput) return;

  senderInput.value = senderId;
  showToast(`✨ Müşteri Instagram ID (${senderId}) ödül formuna kopyalandı!`, 'success');

  if (rewardForm) {
    rewardForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (percentInput) {
    setTimeout(() => percentInput.focus(), 300);
  }
}

function getActiveStoreName() {
  return 'ISCWORKS';
}

function getStoreProducts() {
  return state.products;
}

function saveStoreProducts(productsArray) {
  state.products = productsArray;
}

function handleNewProductSubmit(e) {
  e.preventDefault();
  const shortCodeElem = document.getElementById('shortCode');
  const sizeElem = document.getElementById('sizeInput');
  const nameElem = document.getElementById('productName');
  const colorElem = document.getElementById('colorInput');
  const stockElem = document.getElementById('stockInput');
  const priceElem = document.getElementById('priceInput');
  const catElem = document.getElementById('categoryInput');
  const instagramMediaIdElem = document.getElementById('instagramMediaIdInput');

  if (!shortCodeElem || !nameElem) return;

  const sc = shortCodeElem.value.toUpperCase().trim();
  const size = sizeElem ? sizeElem.value.toUpperCase().trim() : 'M';
  const code = `${sc}-${size}`;
  const name = nameElem.value.trim();
  const color = colorElem ? colorElem.value.trim() : 'Standart';
  const stock = Number(stockElem.value) || 0;
  const price = Number(priceElem.value) || 299;
  const category = catElem ? catElem.value.trim() : 'Genel';

  const newProduct = {
    shortCode: sc,
    productCode: code,
    name: name,
    color: color,
    size: size,
    stock: stock,
    price: price,
    category: category,
    instagramMediaId: instagramMediaIdElem ? instagramMediaIdElem.value.trim() : ''
  };

  const currentProducts = getStoreProducts();
  currentProducts.unshift(newProduct);
  saveStoreProducts(currentProducts);

  showToast(`🎉 "${name}" (${code}) mağazanıza başarıyla eklendi!`, 'success');
  
  const form = document.getElementById('newProductForm');
  if (form) form.reset();

  setTimeout(() => {
    window.location.href = 'stock';
  }, 1000);
}

// Render Products Table
function renderProductsTable() {
  const productsTableBody = document.getElementById('productsTableBody');
  const productsTableCount = document.getElementById('productsTableCount');
  if (!productsTableBody) return;

  const currentProducts = getStoreProducts();
  const query = state.searchQuery;
  const filtered = currentProducts.filter(p => {
    const shortCode = (p.shortCode || '').toLowerCase();
    const code = (p.productCode || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    const color = (p.color || '').toLowerCase();
    const cat = (p.category || '').toLowerCase();
    const instagramMediaId = (p.instagramMediaId || '').toLowerCase();
    return shortCode.includes(query) || code.includes(query) || name.includes(query) || color.includes(query) || cat.includes(query) || instagramMediaId.includes(query);
  });

  if (productsTableCount) productsTableCount.textContent = `${filtered.length} ürün listelendi`;

  if (filtered.length === 0) {
    productsTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="loading-cell" style="padding: 35px 20px; text-align: center; color: #94a3b8;">
          <i class="fa-solid fa-box-open" style="font-size: 24px; margin-bottom: 8px; display: block; color: #64748b;"></i>
          Mağazanızda henüz stoklu ürün bulunmuyor.<br>
          <small style="color: #64748b; font-size: 11px;">"Yeni Ürün Girişi" sayfasından veya S.E.T.T AI Asistanı ile mağazanıza sıfırdan ürün ekleyebilirsiniz.</small>
        </td>
      </tr>
    `;
    return;
  }

  productsTableBody.innerHTML = filtered.map(p => {
    const stock = Number(p.stock) || 0;
    let stockBadge = `<span class="status-badge in-stock">${stock} adet</span>`;

    if (stock <= 0) {
      stockBadge = `<span class="status-badge out-stock">${stock} (Tükendi)</span>`;
    } else if (stock <= 5) {
      stockBadge = `<span class="status-badge low-stock">${stock} (Kritik)</span>`;
    }

    return `
      <tr>
        <td><strong class="text-purple">${escapeHtml(p.shortCode || '-')}</strong></td>
        <td><span class="code-tag">${escapeHtml(p.productCode || '-')}</span></td>
        <td><strong>${escapeHtml(p.name || '-')}</strong></td>
        <td>${escapeHtml(p.color || '-')}</td>
        <td><span class="size-pill">${escapeHtml(p.size || '-')}</span></td>
        <td>
          <div style="display:flex; align-items:center; gap:4px;">
            <input type="number" id="stock_${escapeHtml(p.productCode)}" value="${stock}" min="0" onkeydown="if(event.key==='Enter') saveProductRow('${escapeHtml(p.productCode)}')" style="width:65px; padding:4px 6px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#f8fafc; font-weight:600;" />
            ${stockBadge}
          </div>
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:4px;">
            <input type="number" id="price_${escapeHtml(p.productCode)}" value="${p.price || 299}" min="0" onkeydown="if(event.key==='Enter') saveProductRow('${escapeHtml(p.productCode)}')" style="width:75px; padding:4px 6px; border-radius:6px; border:1px solid #475569; background:#0f172a; color:#4ade80; font-weight:700;" />
          </div>
        </td>
        <td><small class="text-muted">${escapeHtml(p.category || '-')}</small></td>
        <td><span class="code-tag" title="Instagram Media ID">${escapeHtml(p.instagramMediaId || '-')}</span></td>
        <td>
          <div class="action-btn-group">
            <button class="btn btn-sm btn-stock" onclick="saveProductRow('${escapeHtml(p.productCode)}')">
              <i class="fa-solid fa-floppy-disk"></i> Kaydet
            </button>
            <button class="btn btn-sm btn-delete" onclick="deleteProduct('${escapeHtml(p.productCode)}')">
              <i class="fa-solid fa-trash-can"></i> Sil
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Ürün Satırını (Stok & Fiyat) Birlikte Kaydet (API via apiFetch)
async function saveProductRow(productCode) {
  const priceInput = document.getElementById(`price_${productCode}`);
  const stockInput = document.getElementById(`stock_${productCode}`);

  const priceVal = priceInput ? Number(priceInput.value) : undefined;
  const stockVal = stockInput ? Number(stockInput.value) : undefined;

  if (priceVal !== undefined && (isNaN(priceVal) || priceVal < 0)) {
    showToast('Geçersiz fiyat girdiniz.', 'error');
    return;
  }
  if (stockVal !== undefined && (isNaN(stockVal) || stockVal < 0)) {
    showToast('Geçersiz stok girdiniz. Stok 0 veya daha büyük bir sayı olmalıdır.', 'error');
    return;
  }

  try {
    const updates = [{
      productCode,
      ...(priceVal !== undefined ? { price: priceVal } : {}),
      ...(stockVal !== undefined ? { stock: stockVal } : {})
    }];

    const data = await apiFetch('/api/products/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ updates })
    });

    if (data && data.success) {
      showToast(`✅ ${productCode} stok ve fiyat verileri kaydedildi!`, 'success');
      fetchData();
    } else {
      showToast(data?.error || 'Güncelleme kaydedilemedi.', 'error');
    }
  } catch (e) {
    showToast(e.message || 'Güncelleme kaydedilirken sunucu hatası oluştu.', 'error');
  }
}

// Ürün Stoğu Güncelleme (API via apiFetch)
async function updateProductStock(productCode) {
  const stockInput = document.getElementById(`stock_${productCode}`);
  if (!stockInput) return;
  const newStock = Number(stockInput.value);
  if (isNaN(newStock) || newStock < 0) {
    showToast('Geçersiz stok miktarı girdiniz. Stok 0 veya pozitif olmalıdır.', 'error');
    return;
  }

  try {
    const data = await apiFetch('/api/products/update-stock', {
      method: 'POST',
      body: JSON.stringify({ productCode, newStock })
    });
    if (data && data.success) {
      showToast(`✅ ${productCode} stoğu ${data.stock !== undefined ? data.stock : newStock} olarak güncellendi.`, 'success');
      fetchData();
    } else {
      showToast(data?.error || 'Stok güncellenemedi.', 'error');
    }
  } catch (e) {
    showToast(e.message || 'Stok güncellenirken sunucu hatası oluştu.', 'error');
  }
}

// Tüm Ürün Fiyat ve Stoklarını Toplu Kaydet (Bulk Save via apiFetch)
async function saveAllPricesAndStocks() {
  const updates = [];

  for (const p of state.products) {
    if (!p.productCode) continue;
    const priceInput = document.getElementById(`price_${p.productCode}`);
    const stockInput = document.getElementById(`stock_${p.productCode}`);

    const itemUpdate = { productCode: p.productCode };
    let hasChange = false;

    if (priceInput) {
      const val = Number(priceInput.value);
      if (!isNaN(val) && val >= 0) {
        itemUpdate.price = val;
        hasChange = true;
      }
    }
    if (stockInput) {
      const val = Number(stockInput.value);
      if (!isNaN(val) && val >= 0) {
        itemUpdate.stock = val;
        hasChange = true;
      }
    }

    if (hasChange) {
      updates.push(itemUpdate);
    }
  }

  if (updates.length === 0) {
    showToast('Kaydedilecek veri bulunamadı.', 'info');
    return;
  }

  try {
    const data = await apiFetch('/api/products/bulk-update', {
      method: 'POST',
      body: JSON.stringify({ updates })
    });
    if (data && data.success) {
      showToast(`💾 TOPLU KAYIT BAŞARILI!\n${data.updatedCount || updates.length} adet ürünün fiyat ve stok değişiklikleri kaydedildi!`, 'success');
      fetchData();
    } else {
      showToast(`❌ Hata: ${data?.error || 'Toplu kayıt gerçekleştirilemedi.'}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message}`, 'error');
  }
}

// Ürün Fiyatı Güncelleme (API via apiFetch)
async function updateProductPrice(productCode) {
  const priceInput = document.getElementById(`price_${productCode}`);
  if (!priceInput) return;
  const newPrice = Number(priceInput.value);
  if (isNaN(newPrice) || newPrice < 0) {
    showToast('Geçersiz fiyat girdiniz.', 'error');
    return;
  }

  try {
    const data = await apiFetch('/api/products/price', {
      method: 'POST',
      body: JSON.stringify({ productCode, price: newPrice })
    });
    if (data && data.success) {
      showToast(`✅ ${productCode} fiyatı ${newPrice} TL olarak kaydedildi.`, 'success');
      fetchData();
    } else {
      showToast(data?.error || 'Fiyat güncellenemedi.', 'error');
    }
  } catch (e) {
    showToast(e.message || 'Fiyat güncellenirken sunucu hatası oluştu.', 'error');
  }
}

// Render Orders Table
function renderOrdersTable() {
  const ordersTableBody = document.getElementById('ordersTableBody');
  const ordersTableCount = document.getElementById('ordersTableCount');
  if (!ordersTableBody) return;

  const query = state.searchQuery;
  const filtered = state.orders.filter(o => {
    const id = (o.orderId || '').toLowerCase();
    const sender = (o.senderId || '').toLowerCase();
    const name = (o.customerName || '').toLowerCase();
    const phone = (o.customerPhone || '').toLowerCase();
    const code = (o.productCode || '').toLowerCase();
    return id.includes(query) || sender.includes(query) || name.includes(query) || phone.includes(query) || code.includes(query);
  });

  if (ordersTableCount) ordersTableCount.textContent = `${filtered.length} sipariş listelendi`;

  if (filtered.length === 0) {
    ordersTableBody.innerHTML = `
      <tr>
        <td colspan="10" class="loading-cell">
          <i class="fa-solid fa-inbox"></i> Sipariş bulunamadı.
        </td>
      </tr>
    `;
    return;
  }

  ordersTableBody.innerHTML = filtered.map(o => {
    const status = (o.status || 'BEKLEMEDE').toUpperCase();
    let statusBadge = `<span class="status-badge pending">${status}</span>`;

    if (status === 'OK' || status === 'ONAYLANDI') {
      statusBadge = `<span class="status-badge success"><i class="fa-solid fa-check"></i> ONAYLANDI</span>`;
    } else if (status === 'DEC' || status === 'REDDEDİLMEDİ') {
      statusBadge = `<span class="status-badge danger"><i class="fa-solid fa-xmark"></i> REDDEDİLDİ</span>`;
    }

    const totalPriceNum = Number(o.totalPrice);
    const qty = Number(o.quantity) || 1;
    const fallbackPrice = qty * 299;

    let priceDisplay = `<strong class="text-green">${fallbackPrice.toFixed(2)} TL</strong>`;
    if (!isNaN(totalPriceNum) && totalPriceNum > 0) {
      priceDisplay = `<strong class="text-green">${totalPriceNum.toFixed(2)} TL</strong>`;
    }

    return `
      <tr style="cursor:pointer;" onclick="openOrderDetailsModal('${escapeHtml(o.orderId)}')">
        <td><strong class="text-purple">${escapeHtml(o.orderId || '-')}</strong></td>
        <td><strong>${escapeHtml(o.customerName || '-')}</strong></td>
        <td><span class="code-tag">${escapeHtml(o.customerPhone || '-')}</span></td>
        <td><small class="text-muted">${escapeHtml(o.address || '-')}</small></td>
        <td><span class="size-pill">${escapeHtml(o.productCode || '-')}</span></td>
        <td><strong>${o.quantity || 1}</strong></td>
        <td>${priceDisplay}</td>
        <td>${statusBadge}</td>
        <td><small class="text-muted">${escapeHtml(o.createdAt || '-')}</small></td>
        <td>
          <div class="action-btn-group" onclick="event.stopPropagation()">
            <button class="btn btn-sm btn-secondary" onclick="openOrderDetailsModal('${escapeHtml(o.orderId)}')">
              <i class="fa-solid fa-eye"></i> Detay
            </button>
            <button class="btn btn-sm btn-success" onclick="updateOrderStatus('${escapeHtml(o.orderId)}', 'OK')">
              <i class="fa-solid fa-check"></i> Onayla
            </button>
            <button class="btn btn-sm btn-warning" style="background:#eab308; color:#000; font-weight:600;" onclick="updateOrderStatus('${escapeHtml(o.orderId)}', 'DEC')">
              <i class="fa-solid fa-xmark"></i> Reddet
            </button>
            <button class="btn btn-sm btn-delete" onclick="deleteOrder('${escapeHtml(o.orderId)}')">
              <i class="fa-solid fa-trash"></i> Sil
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}



// Handle Gemini AI Product Submit
async function handleAiProductSubmit() {
  const promptInput = document.getElementById('aiProductPrompt');
  const submitBtn = document.getElementById('btnSubmitAiProduct');
  const aiResultBox = document.getElementById('aiResultBox');
  const aiResultContent = document.getElementById('aiResultContent');

  const promptText = (promptInput?.value || '').trim();
  if (!promptText) {
    showToast('Lütfen yapay zekaya bir ürün açıklaması yazın.', 'error');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Gemini AI Analiz Ediyor...`;
  }

  try {
    const res = await fetch(`${API_BASE}/api/ai/create-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`✨ ${data.message || 'Ürünler AI tarafından kaydedildi!'}`, 'success');
      if (aiResultBox && aiResultContent) {
        aiResultBox.style.display = 'block';
        aiResultContent.textContent = JSON.stringify(data, null, 2);
      }
      if (promptInput) promptInput.value = '';
      fetchData();
    } else {
      showToast(`❌ AI Hatası: ${data.error || 'İşlem başarısız'}`, 'error');
    }
  } catch (err) {
    showToast('Gemini AI bağlantı hatası.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i class="fa-solid fa-robot"></i> Yapay Zeka İle Oluştur ve Kaydet`;
    }
  }
}

// Sipariş Durumu Güncelleme (OK veya DEC)
async function updateOrderStatus(orderId, status) {
  if (status === 'DEC') {
    openRejectionModal(orderId);
    return;
  }

  try {
    const data = await apiFetch('/api/orders/status', {
      method: 'POST',
      body: JSON.stringify({ orderId, status: 'OK' })
    });

    if (data.success) {
      showToast(`✅ Sipariş ${orderId} onaylandı! Müşteriye bildirim gönderildi.`, 'success');
      fetchData();
    } else {
      showToast(`❌ Hata: ${data.error || 'Sipariş durumu güncellenemedi.'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Hata: ${err?.message || 'Sipariş güncellenirken sunucu hatası oluştu.'}`, 'error');
  }
}

// Order Details Modal Dynamic Engine
function getOrCreateOrderDetailsModal() {
  let modal = document.getElementById('orderDetailsModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'orderDetailsModal';
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(10px);
    display: none; align-items: center; justify-content: center; z-index: 9999;
  `;

  modal.innerHTML = `
    <div style="background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 16px; width: 92%; max-width: 680px; padding: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8); animation: modalFadeIn 0.3s ease; max-height: 90vh; overflow-y: auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; border-bottom:1px solid #334155; padding-bottom:1rem;">
        <h3 style="color:#f8fafc; margin:0; font-size:1.3rem; display:flex; align-items:center; gap:10px;">
          <i class="fa-solid fa-receipt text-gold"></i> Sipariş Detay İnceleme Ekranı
        </h3>
        <button id="btnCloseOrderDetailsModal" style="background:none; border:none; color:#94a3b8; font-size:1.6rem; cursor:pointer;">&times;</button>
      </div>

      <div id="orderDetailsModalBody">
        <!-- Dynamic Order Details Content -->
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:1.5rem; border-top:1px solid #334155; padding-top:1.25rem; flex-wrap:wrap; gap:10px;" id="orderDetailsModalFooter">
        <!-- Action Buttons -->
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const btnClose = document.getElementById('btnCloseOrderDetailsModal');
  if (btnClose) btnClose.onclick = () => { modal.style.display = 'none'; };

  return modal;
}

function openOrderDetailsModal(orderId) {
  const order = state.orders.find(o => o.orderId === orderId);
  if (!order) {
    showToast('Sipariş detayları bulunamadı.', 'error');
    return;
  }

  const modal = getOrCreateOrderDetailsModal();
  const body = document.getElementById('orderDetailsModalBody');
  const footer = document.getElementById('orderDetailsModalFooter');

  const status = (order.status || 'BEKLEMEDE').toUpperCase();
  let statusBadge = `<span class="status-badge pending">${status}</span>`;
  if (status === 'OK' || status === 'ONAYLANDI') {
    statusBadge = `<span class="status-badge success"><i class="fa-solid fa-check"></i> ONAYLANDI</span>`;
  } else if (status === 'DEC' || status === 'REDDEDİLDİ') {
    statusBadge = `<span class="status-badge danger"><i class="fa-solid fa-xmark"></i> REDDEDİLDİ</span>`;
  }

  const totalPriceNum = Number(order.totalPrice);
  const qty = Number(order.quantity) || 1;
  const fallbackPrice = qty * 299;
  const netTotal = (!isNaN(totalPriceNum) && totalPriceNum > 0) ? totalPriceNum : fallbackPrice;

  const phoneClean = (order.customerPhone || '').replace(/[^0-9]/g, '');
  const whatsappUrl = phoneClean ? `https://wa.me/${phoneClean.startsWith('90') ? phoneClean : '90' + phoneClean}` : '#';

  if (body) {
    body.innerHTML = `
      <!-- Sipariş Üst Kimlik Kartı -->
      <div style="background:#0f172a; border:1px solid #334155; border-radius:12px; padding:1.25rem; margin-bottom:1.25rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div>
          <span style="color:#94a3b8; font-size:0.8rem; text-transform:uppercase; font-weight:600;">SİPARİŞ NUMARASI</span>
          <h2 style="color:#a855f7; margin:2px 0 0 0; font-size:1.3rem;">#${escapeHtml(order.orderId)}</h2>
        </div>
        <div style="text-align:right;">
          <span style="color:#94a3b8; font-size:0.8rem; text-transform:uppercase; font-weight:600;">DURUM & TARİH</span>
          <div style="margin-top:4px; display:flex; align-items:center; gap:8px;">
            ${statusBadge}
            <span style="color:#cbd5e1; font-size:0.85rem;"><i class="fa-solid fa-clock"></i> ${escapeHtml(order.createdAt || '-')}</span>
          </div>
        </div>
      </div>

      <!-- Müşteri ve İletişim Bilgileri Kartı -->
      <div style="background:#0f172a; border:1px solid #334155; border-radius:12px; padding:1.25rem; margin-bottom:1.25rem;">
        <h4 style="color:#fbbf24; margin:0 0 1rem 0; font-size:1rem; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-user-gear"></i> Müşteri & İletişim Bilgileri
        </h4>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; font-size:0.9rem;">
          <div>
            <span style="color:#94a3b8; display:block; font-size:0.8rem;">Adı Soyadı:</span>
            <strong style="color:#f8fafc; font-size:1rem;">👤 ${escapeHtml(order.customerName)}</strong>
          </div>
          <div>
            <span style="color:#94a3b8; display:block; font-size:0.8rem;">Telefon Numarası:</span>
            <strong style="color:#38bdf8;">
              📞 <a href="tel:${escapeHtml(order.customerPhone)}" style="color:inherit; text-decoration:none;">${escapeHtml(order.customerPhone)}</a>
              ${phoneClean ? `<a href="${whatsappUrl}" target="_blank" style="margin-left:6px; color:#22c55e;" title="WhatsApp İle İletişim Kur"><i class="fa-brands fa-whatsapp"></i></a>` : ''}
            </strong>
          </div>
          <div>
            <span style="color:#94a3b8; display:block; font-size:0.8rem;">Instagram ID (senderId):</span>
            <span class="code-tag" style="background:#1e293b; color:#cbd5e1; padding:3px 8px; border-radius:6px;">${escapeHtml(order.senderId || 'Web Siparişi / Yok')}</span>
          </div>
        </div>

        <div style="margin-top:1rem; border-top:1px dashed #334155; padding-top:0.75rem;">
          <span style="color:#94a3b8; display:block; font-size:0.8rem; margin-bottom:4px;">📍 Teslimat Adresi:</span>
          <div style="background:#1e293b; border:1px solid #334155; padding:0.75rem; border-radius:8px; color:#f8fafc; font-size:0.9rem; line-height:1.4; display:flex; justify-content:space-between; align-items:center;">
            <span>${escapeHtml(order.address)}</span>
            <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText('${escapeHtml(order.address)}'); showToast('📋 Adres panoya kopyalandı!','success');" title="Adresi Kopyala">
              <i class="fa-solid fa-copy"></i> Kopyala
            </button>
          </div>
        </div>
      </div>

      <!-- Ürün ve Tutar Sepet Detay Kartı -->
      <div style="background:#0f172a; border:1px solid #334155; border-radius:12px; padding:1.25rem;">
        <h4 style="color:#34d399; margin:0 0 1rem 0; font-size:1rem; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-bag-shopping"></i> Ürün & Sepet Detayları
        </h4>
        <div style="display:flex; justify-content:space-between; align-items:center; background:#1e293b; padding:0.85rem 1rem; border-radius:8px; margin-bottom:1rem; border:1px solid #334155;">
          <div>
            <strong style="color:#f8fafc; font-size:1rem;">🛍️ ${escapeHtml(order.productName || order.productCode)}</strong>
            <div style="margin-top:4px; display:flex; gap:8px;">
              <span class="size-pill">${escapeHtml(order.productCode)}</span>
              <span class="code-tag">Beden: ${escapeHtml(order.size || 'M')}</span>
              <span class="code-tag">Adet: ${order.quantity || 1}</span>
            </div>
          </div>
          <div style="text-align:right;">
            <span style="color:#94a3b8; font-size:0.8rem; display:block;">Net Toplam Tutar:</span>
            <strong style="color:#22c55e; font-size:1.25rem;">${netTotal.toFixed(2)} TL</strong>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; background:#0f172a; padding:0.75rem; border-radius:8px; font-size:0.85rem; text-align:center;">
          <div><span style="color:#94a3b8;">Birim Fiyat:</span><br><strong style="color:#cbd5e1;">${(Number(order.unitPrice) || 299).toFixed(2)} TL</strong></div>
          <div><span style="color:#94a3b8;">Kargo Ücreti:</span><br><strong style="color:#cbd5e1;">${(Number(order.shippingFee) || 0).toFixed(2)} TL</strong></div>
          <div><span style="color:#94a3b8;">İndirim:</span><br><strong style="color:#f43f5e;">-${(Number(order.discount) || 0).toFixed(2)} TL</strong></div>
        </div>
      </div>
    `;
  }

  if (footer) {
    footer.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-sm btn-success" onclick="updateOrderStatus('${escapeHtml(order.orderId)}', 'OK'); document.getElementById('orderDetailsModal').style.display='none';">
          <i class="fa-solid fa-check"></i> Siparişi Onayla
        </button>
        <button class="btn btn-sm btn-warning" style="background:#eab308; color:#000; font-weight:600;" onclick="document.getElementById('orderDetailsModal').style.display='none'; openRejectionModal('${escapeHtml(order.orderId)}');">
          <i class="fa-solid fa-xmark"></i> Siparişi Reddet & DM Yolla
        </button>
        <button class="btn btn-sm btn-delete" onclick="document.getElementById('orderDetailsModal').style.display='none'; deleteOrder('${escapeHtml(order.orderId)}');">
          <i class="fa-solid fa-trash"></i> Siparişi Sil
        </button>
        ${order.senderId ? `
          <button class="btn btn-sm btn-secondary" onclick="document.getElementById('orderDetailsModal').style.display='none'; selectOrderForReward('${escapeHtml(order.senderId)}');">
            <i class="fa-solid fa-gift text-gold"></i> VIP Ödül Tanımla
          </button>
        ` : ''}
      </div>
      <button class="btn btn-sm" style="background:#334155; color:#f8fafc;" onclick="document.getElementById('orderDetailsModal').style.display='none';">
        Kapat (&times;)
      </button>
    `;
  }

  modal.style.display = 'flex';
}

// Rejection Modal Dynamic Engine
function getOrCreateRejectionModal() {
  let modal = document.getElementById('rejectionModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'rejectionModal';
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(10px);
    display: none; align-items: center; justify-content: center; z-index: 9999;
  `;

  modal.innerHTML = `
    <div style="background: linear-gradient(135deg, #1e293b, #0f172a); border: 1px solid #334155; border-radius: 16px; width: 90%; max-width: 520px; padding: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7); animation: modalFadeIn 0.3s ease;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; border-bottom:1px solid #334155; padding-bottom:1rem;">
        <h3 style="color:#f43f5e; margin:0; font-size:1.25rem; display:flex; align-items:center; gap:8px;">
          <i class="fa-solid fa-circle-xmark"></i> Siparişi Reddet & Müşteriye Bildir
        </h3>
        <button id="btnCloseRejectionModal" style="background:none; border:none; color:#94a3b8; font-size:1.5rem; cursor:pointer;">&times;</button>
      </div>

      <p style="color:#cbd5e1; font-size:0.9rem; margin-bottom:1.2rem;" id="rejectionModalSubtitle">
        Siparişi reddetme nedeninizi seçin. Müşterinin Instagram hesabına doğrudan DM mesajı olarak gönderilecektir.
      </p>

      <div style="margin-bottom:1.2rem;">
        <label style="display:block; color:#94a3b8; font-size:0.85rem; font-weight:600; margin-bottom:0.5rem;">
          📋 İptal / Red Sebebi Şablonu Seçin:
        </label>
        <select id="rejectionReasonSelect" style="width:100%; padding:0.75rem; border-radius:8px; border:1px solid #475569; background:#0f172a; color:#f8fafc; font-size:0.9rem; font-weight:500;">
          <option value="stok">📦 Stok Tükenmesi (Ürün / Beden Tükendi)</option>
          <option value="adres">📍 Eksik / Anlaşılmayan Teslimat Adresi</option>
          <option value="odeme">💳 Ödeme / Dekont Doğrulaması Başarısız</option>
          <option value="iletisim">📞 Müşteri ile İletişim Kurulamadı</option>
          <option value="ozel">✏️ Özel Nedeni Kendim Yazacağım</option>
        </select>
      </div>

      <div style="margin-bottom:1.5rem;">
        <label style="display:block; color:#94a3b8; font-size:0.85rem; font-weight:600; margin-bottom:0.5rem;">
          💬 Müşteriye Gidecek Mesaj Önizlemesi:
        </label>
        <textarea id="rejectionReasonText" rows="4" style="width:100%; padding:0.75rem; border-radius:8px; border:1px solid #475569; background:#0f172a; color:#f8fafc; font-size:0.88rem; font-family:inherit; resize:vertical;"></textarea>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:12px;">
        <button id="btnCancelRejection" class="btn btn-sm" style="background:#334155; color:#f8fafc; padding:0.6rem 1.2rem; border-radius:8px; border:none; cursor:pointer;">Vazgeç</button>
        <button id="btnConfirmRejection" class="btn btn-sm btn-delete" style="padding:0.6rem 1.2rem; border-radius:8px; cursor:pointer;">
          <i class="fa-solid fa-paper-plane"></i> Reddet & DM Yolla
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const reasonTemplates = {
    stok: 'Üzülerek bildiririz ki sipariş ettiğiniz ürün/beden stoklarımızda kalmadığı için siparişiniz onaylanamamıştır. Anlayışınız için teşekkür ederiz.',
    adres: 'Girdiğiniz teslimat adresi veya iletişim bilgileri eksik/anlaşılmasız olduğu için siparişiniz işleme alınamamıştır. Lütfen güncel bilgilerinizle tekrar iletişime geçiniz.',
    odeme: 'Siparişinize ait ödeme doğrulaması gerçekleştirilemediği için siparişiniz işleme alınamamıştır.',
    iletisim: 'Sipariş teyidi için sizinle iletişim kurulamadığından siparişiniz iptal edilmiştir.',
    ozel: ''
  };

  const select = document.getElementById('rejectionReasonSelect');
  const textarea = document.getElementById('rejectionReasonText');
  const btnClose = document.getElementById('btnCloseRejectionModal');
  const btnCancel = document.getElementById('btnCancelRejection');

  if (select && textarea) {
    textarea.value = reasonTemplates.stok;
    select.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'ozel') {
        textarea.value = '';
        textarea.focus();
      } else {
        textarea.value = reasonTemplates[val] || '';
      }
    });
  }

  const closeModal = () => { modal.style.display = 'none'; };
  if (btnClose) btnClose.onclick = closeModal;
  if (btnCancel) btnCancel.onclick = closeModal;

  return modal;
}

function openRejectionModal(orderId) {
  const modal = getOrCreateRejectionModal();
  const subtitle = document.getElementById('rejectionModalSubtitle');
  const btnConfirm = document.getElementById('btnConfirmRejection');
  const textarea = document.getElementById('rejectionReasonText');

  if (subtitle) subtitle.textContent = `Sipariş #${orderId} için red sebebi seçin. Müşterinin Instagram hesabına doğrudan DM mesajı olarak gönderilecektir.`;
  modal.style.display = 'flex';

  if (btnConfirm) {
    btnConfirm.onclick = async () => {
      const reason = textarea ? textarea.value.trim() : '';
      if (!reason) {
        showToast('Lütfen müşteriye gönderilecek red nedenini yazın veya seçin.', 'error');
        return;
      }

      btnConfirm.disabled = true;
      btnConfirm.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Gönderiliyor...`;

      try {
        const data = await apiFetch('/api/orders/status', {
          method: 'POST',
          body: JSON.stringify({ orderId, status: 'DEC', reason })
        });
        if (data.success) {
          showToast(`✅ Sipariş ${orderId} reddedildi ve müşteriye DM bildirimi yollandı.`, 'success');
          modal.style.display = 'none';
          fetchData();
        } else {
          showToast(`❌ Hata: ${data.error || 'Sipariş reddedilemedi'}`, 'error');
        }
      } catch (e) {
        showToast(`❌ Hata: ${e?.message || 'Sunucu bağlantı hatası oluştu.'}`, 'error');
      } finally {
        btnConfirm.disabled = false;
        btnConfirm.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Reddet & DM Yolla`;
      }
    };
  }
}

// Ürün Silme (API via apiFetch)
async function deleteProduct(productCode) {
  if (!confirm(`${productCode} kodlu ürünü silmek istediğinize emin misiniz?`)) return;

  try {
    const data = await apiFetch('/api/products/delete', {
      method: 'POST',
      body: JSON.stringify({ productCode })
    });
    if (data && data.success) {
      showToast(`✅ ${productCode} silindi.`, 'success');
      fetchData();
    } else {
      showToast(`❌ Hata: ${data?.error || 'Silinemedi'}`, 'error');
    }
  } catch (err) {
    showToast(err.message || 'Silme işlemi başarısız oldu.', 'error');
  }
}

// Fetch and Handle Settings
// Fetch and Handle Settings (API via apiFetch)
async function fetchSettings() {
  const settingShippingFee = document.getElementById('settingShippingFee');
  const settingFreeThreshold = document.getElementById('settingFreeThreshold');
  if (!settingShippingFee && !settingFreeThreshold) return;

  try {
    const data = await apiFetch('/api/settings');
    if (data && data.success && data.settings) {
      if (settingShippingFee) settingShippingFee.value = data.settings.shipping_fee || '49';
      if (settingFreeThreshold) settingFreeThreshold.value = data.settings.free_shipping_threshold || '1500';
    }
  } catch (e) {}
}

async function handleSettingsSubmit(e) {
  e.preventDefault();
  const settingShippingFee = document.getElementById('settingShippingFee');
  const settingFreeThreshold = document.getElementById('settingFreeThreshold');

  const shippingFee = settingShippingFee ? settingShippingFee.value : '49';
  const freeThreshold = settingFreeThreshold ? settingFreeThreshold.value : '1500';

  try {
    const data = await apiFetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ settings: { shipping_fee: shippingFee, free_shipping_threshold: freeThreshold } })
    });
    if (data && data.success) {
      showToast('✅ Kargo fiyat ayarları kaydedildi!', 'success');
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || 'Ayarlar kaydedilemedi.');
      showToast(`❌ Hata: ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message || 'Ayarlar kaydedilirken hata oluştu.'}`, 'error');
  }
}

// Fetch and Handle Campaigns (API via apiFetch)
async function fetchCampaigns() {
  const tableBody = document.getElementById('campaignsTableBody');
  if (!tableBody) return;

  try {
    const data = await apiFetch('/api/campaigns');
    if (data && data.success && Array.isArray(data.campaigns)) {
      if (data.campaigns.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #94a3b8;">Henüz aktif bir kampanya eklenmemiş. Yeni kampanya ekleyebilirsiniz.</td></tr>`;
        return;
      }
      tableBody.innerHTML = data.campaigns.map(c => {
        let endDateBadge = '<span class="status-badge in-stock">Süresiz</span>';
        if (c.end_date) {
          const isExpired = new Date(c.end_date) < new Date(new Date().setHours(0,0,0,0));
          if (isExpired) {
            endDateBadge = `<span class="status-badge out-stock">⏳ ${c.end_date} (Süresi Doldu)</span>`;
          } else {
            endDateBadge = `<span class="status-badge low-stock">📅 Son: ${c.end_date}</span>`;
          }
        }

        return `
          <tr>
            <td>#${c.id}</td>
            <td><strong>${escapeHtml(c.title)}</strong></td>
            <td>${escapeHtml(c.description)}</td>
            <td><span class="code-tag">${escapeHtml(c.code || '-')}</span></td>
            <td><strong class="text-green">${[Number(c.discount_percent) > 0 ? `%${Number(c.discount_percent)}` : '', Number(c.discount_amount) > 0 ? `${Number(c.discount_amount).toLocaleString('tr-TR')} TL` : ''].filter(Boolean).join(' + ') || '-'}</strong>${Number(c.min_order_amount) > 0 ? `<small class="text-muted" style="display:block">Min. ${Number(c.min_order_amount).toLocaleString('tr-TR')} TL</small>` : ''}</td>
            <td>${endDateBadge}</td>
            <td>
              <button class="btn btn-sm btn-delete" onclick="deleteCampaign(${c.id})"><i class="fa-solid fa-trash-can"></i> Sil</button>
            </td>
          </tr>
        `;
      }).join('');
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || 'Kampanyalar yüklenemedi.');
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #ef4444;">${escapeHtml(errMsg)}</td></tr>`;
    }
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #ef4444;">Bağlantı hatası: ${escapeHtml(e.message)}</td></tr>`;
  }
}

async function handleCampaignSubmit(e) {
  e.preventDefault();

  const titleElem = document.getElementById('campTitle');
  const codeElem = document.getElementById('campCode');
  const percentElem = document.getElementById('campPercent');
  const amountElem = document.getElementById('campAmount');
  const minOrderElem = document.getElementById('campMinOrder');
  const descElem = document.getElementById('campDesc');
  const startDateElem = document.getElementById('campStartDate');
  const endDateElem = document.getElementById('campEndDate');

  if (!titleElem || !descElem) {
    showToast('Lütfen başlık ve açıklama alanlarını doldurun.', 'error');
    return;
  }

  const payload = {
    title: titleElem.value.trim(),
    code: codeElem ? codeElem.value.trim().toUpperCase() : '',
    discountPercent: percentElem ? (Number(percentElem.value) || 0) : 0,
    discountAmount: amountElem ? (Number(amountElem.value) || 0) : 0,
    minOrderAmount: minOrderElem ? (Number(minOrderElem.value) || 0) : 0,
    description: descElem.value.trim(),
    startDate: startDateElem ? startDateElem.value : null,
    endDate: endDateElem ? endDateElem.value : null
  };

  if (!payload.title || !payload.description) {
    showToast('Başlık ve Açıklama zorunludur.', 'error');
    return;
  }

  try {
    const data = await apiFetch('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (data && data.success) {
      showToast('🎉 Yeni kampanya başarıyla başlatıldı ve kaydedildi!', 'success');
      const form = document.getElementById('campaignForm');
      if (form) form.reset();
      fetchCampaigns();
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || data?.message || 'Bilinmeyen sunucu hatası');
      showToast(`❌ Kampanya kaydedilemedi: ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Sunucu Bağlantı Hatası: ${e.message}`, 'error');
  }
}

async function deleteCampaign(id) {
  if (!confirm('Kampanyayı silmek istediğinize emin misiniz?')) return;
  try {
    const data = await apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' });
    if (data && data.success) {
      showToast('✅ Kampanya silindi.', 'success');
      fetchCampaigns();
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || 'Kampanya silinemedi.');
      showToast(`❌ Hata: ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message || 'Kampanya silinirken hata oluştu.'}`, 'error');
  }
}

// Handle Custom VIP Reward Submit (API via apiFetch)
async function handleRewardSubmit(e) {
  e.preventDefault();

  const senderIdElem = document.getElementById('rewardSenderId');
  const codeElem = document.getElementById('rewardCode');
  const percentElem = document.getElementById('rewardPercent');
  const minAmountElem = document.getElementById('rewardMinAmount');

  if (!senderIdElem || !percentElem) return;

  const payload = {
    senderId: senderIdElem.value.trim(),
    rewardCode: codeElem ? (codeElem.value.trim().toUpperCase() || 'VIP20') : 'VIP20',
    discountPercent: Number(percentElem.value) || 20,
    minQualifyingAmount: minAmountElem ? (Number(minAmountElem.value) || 2000) : 2000
  };

  try {
    const data = await apiFetch('/api/rewards', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (data && data.success) {
      showToast(
        data.notificationSent
          ? '💎 VIP Sadakat Ödülü eklendi ve müşteriye Instagram DM gönderildi!'
          : '⚠️ VIP ödülü eklendi fakat Instagram DM gönderilemedi.',
        data.notificationSent ? 'success' : 'warning'
      );
      const form = document.getElementById('rewardForm');
      if (form) form.reset();
      fetchData();
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || 'Eklenemedi');
      showToast(`❌ Hata: ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message || 'Ödül eklenirken sunucu hatası oluştu.'}`, 'error');
  }
}

async function deleteReward(id) {
  if (!confirm('Bu VIP ödülünü silmek istediğinize emin misiniz?')) return;
  try {
    const data = await apiFetch(`/api/rewards/${id}`, { method: 'DELETE' });
    if (data && data.success) {
      showToast('✅ VIP Ödülü silindi.', 'success');
      fetchData();
    } else {
      const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || 'Silinemedi.');
      showToast(`❌ Hata: ${errMsg}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message || 'Silme hatası oluştu.'}`, 'error');
  }
}

// UI Status Badge Helper
function setSyncStatus(type, message) {
  const syncBadge = document.getElementById('syncStatusBadge');
  if (!syncBadge) return;
  syncBadge.className = `sync-badge ${type}`;
  const span = syncBadge.querySelector('span:not(.pulse-dot)');
  if (span) span.textContent = message;
}

// Toast Notification Engine
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${icon} toast-icon"></i>
    <div class="toast-message">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// HTML Escape Utility
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Quick Action Helper for AI Copilot
function setAiPrompt(text) {
  const input = document.getElementById('aiAdminChatInput');
  if (input) {
    input.value = text;
    input.focus();
  }
}

// Admin Copilot Chat Logic
async function sendAdminChatMessage() {
  const input = document.getElementById('aiAdminChatInput');
  const chatWindow = document.getElementById('aiAdminChatWindow');
  const sendBtn = document.getElementById('btnSendAdminChat');

  if (!input || !chatWindow) return;
  const prompt = input.value.trim();
  if (!prompt) return;

  // Append User Message Bubble (Patron)
  const userBubble = document.createElement('div');
  userBubble.style.cssText = 'display:flex; gap:10px; justify-content:flex-end; align-items:flex-start; margin-top:6px;';
  userBubble.innerHTML = `
    <div style="background:linear-gradient(135deg, #2563eb, #1d4ed8); color:#ffffff; padding:0.85rem 1.1rem; border-radius:12px; border-top-right-radius:2px; max-width:80%; font-size:0.92rem; line-height:1.5;">
      ${escapeHtml(prompt).replace(/\n/g, '<br>')}
    </div>
    <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #fbbf24, #f59e0b); display:flex; align-items:center; justify-content:center; color:#000; font-size:16px; font-weight:bold;">
      <i class="fa-solid fa-crown"></i>
    </div>
  `;
  chatWindow.appendChild(userBubble);

  input.value = '';
  chatWindow.scrollTop = chatWindow.scrollHeight;

  // Loading Indicator Bubble
  const loadingBubble = document.createElement('div');
  loadingBubble.id = 'aiLoadingBubble';
  loadingBubble.style.cssText = 'display:flex; gap:10px; align-items:flex-start; margin-top:6px;';
  loadingBubble.innerHTML = `
    <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #a855f7, #6366f1); display:flex; align-items:center; justify-content:center; color:#fff; font-size:16px;">
      <i class="fa-solid fa-robot"></i>
    </div>
    <div style="background:#1e293b; color:#94a3b8; padding:0.85rem 1.1rem; border-radius:12px; border-top-left-radius:2px; font-size:0.92rem; border:1px solid #334155;">
      <i class="fa-solid fa-spinner fa-spin"></i> S.E.T.T emrinizi işliyor...
    </div>
  `;
  chatWindow.appendChild(loadingBubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (sendBtn) sendBtn.disabled = true;

  try {
    const data = await apiFetch('/api/ai/admin-copilot', {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });
    loadingBubble.remove();

    const replyText = data?.reply || data?.error || '❌ S.E.T.T yanıt oluşturamadı.';

    // Append AI Response Bubble
    const aiBubble = document.createElement('div');
    aiBubble.style.cssText = 'display:flex; gap:10px; align-items:flex-start; margin-top:6px;';
    aiBubble.innerHTML = `
      <div style="width:36px; height:36px; border-radius:50%; background:linear-gradient(135deg, #a855f7, #6366f1); display:flex; align-items:center; justify-content:center; color:#fff; font-size:16px;">
        <i class="fa-solid fa-robot"></i>
      </div>
      <div style="background:#1e293b; color:#f8fafc; padding:0.85rem 1.1rem; border-radius:12px; border-top-left-radius:2px; max-width:80%; font-size:0.92rem; line-height:1.5; border:1px solid #334155;">
        ${escapeHtml(replyText).replace(/\n/g, '<br>')}
      </div>
    `;
    chatWindow.appendChild(aiBubble);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Tazeleme
    fetchData();

  } catch (err) {
    if (loadingBubble) loadingBubble.remove();
    showToast(`❌ S.E.T.T hatası: ${err?.message || 'Sunucuya bağlanılamadı.'}`, 'error');
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

// Sipariş Silme (Tüm Panellerden)
async function deleteOrder(orderId) {
  if (!confirm(`Sipariş #${orderId} kaydını veritabanından silmek istediğinize emin misiniz?`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/orders/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`🗑️ Sipariş #${orderId} başarıyla silindi.`, 'success');
      fetchData();
    } else {
      showToast(`❌ Sipariş silinemedi: ${data.error || ''}`, 'error');
    }
  } catch (err) {
    showToast('Sunucu hatası oluştu.', 'error');
  }
}

// Auto VIP Reward Setting Toggle Engine
async function loadAutoRewardSetting() {
  const badge = document.getElementById('autoRewardStatusBadge');
  const btn = document.getElementById('btnToggleAutoReward');
  if (!badge || !btn) return;

  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    const data = await res.json();
    if (data.success && data.settings) {
      const val = data.settings.auto_vip_reward_enabled;
      const isEnabled = val === '1' || val === 'true';

      if (isEnabled) {
        badge.className = 'status-badge in-stock';
        badge.innerHTML = '<i class="fa-solid fa-circle text-green" style="font-size:8px;"></i> AÇIK (Yapay Zeka Verir)';
        btn.innerHTML = '<i class="fa-solid fa-toggle-on text-green"></i> Kapat (Manuel Yap)';
      } else {
        badge.className = 'status-badge out-of-stock';
        badge.textContent = 'KAPALI (Sadece Manuel)';
        btn.innerHTML = '<i class="fa-solid fa-toggle-off"></i> Aç (Yapay Zekaya Ver)';
      }
    }
  } catch (e) {}
}

async function toggleAutoRewardSetting() {
  const badge = document.getElementById('autoRewardStatusBadge');
  if (!badge) return;

  const currentlyEnabled = badge.textContent.includes('AÇIK');
  const newValue = currentlyEnabled ? '0' : '1';

  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'auto_vip_reward_enabled', value: newValue })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Otomatik VIP Ödülü ayarı ${newValue === '1' ? 'AÇILDI' : 'KAPATILDI (Sadece Satıcı Manuel Ekler)'}`, 'success');
      loadAutoRewardSetting();
    }
  } catch (e) {
    showToast('Ayar değiştirilemedi.', 'error');
  }
}

// API & AI Customization Modal Engine
function getOrCreateSystemSettingsModal() {
  let modal = document.getElementById('systemSettingsModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'systemSettingsModal';
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(15, 23, 42, 0.8); backdrop-filter: blur(8px);
    display: none; align-items: center; justify-content: center; z-index: 99999;
  `;

  modal.innerHTML = `
    <div class="card" style="width: 92%; max-width: 650px; padding: 25px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); border: 1px solid var(--border); max-height: 90vh; overflow-y: auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:15px; margin-bottom:20px;">
        <h3 style="font-size:16px; font-weight:800; display:flex; align-items:center; gap:9px; color:var(--text);">
          <i class="fa-solid fa-sliders" style="color:var(--primary);"></i> API Ayarları & Yapay Zeka Kişiselleştirme
        </h3>
        <button id="btnCloseSystemSettingsModal" style="background:none; border:none; font-size:22px; cursor:pointer; color:var(--muted);">&times;</button>
      </div>

      <!-- Settings Tabs -->
      <div style="display:flex; gap:10px; margin-bottom:20px; border-bottom:1px solid var(--border); padding-bottom:10px;">
        <button class="btn btn-sm btn-primary" id="tabBtnAiCustom" onclick="switchSettingsTab('ai')">
          🤖 Yapay Zeka Kişiselleştirme
        </button>
      </div>

      <!-- Tab 1: AI Customization -->
      <div id="tabContentAi" style="display:block;">
        <div class="form-group" style="margin-bottom:14px;">
          <label>Yapay Zeka Ses Tonu & Kişilik Üslubu</label>
          <select id="sysBotTone" class="select" style="width:100%; height:40px; font-size:12px;">
            <option value="luxury">Lüks Parfüm Danışmanı & Saygılı (Önerilen)</option>
            <option value="friendly">Samimi, Sıcak & Yardımsever</option>
            <option value="formal">Kurumsal, Kısa & Profesyonel</option>
            <option value="patron">Yönetici Asistanı</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label>Özel Sistem Talimatı / Persona Promptu</label>
          <textarea id="sysBotSystemPrompt" rows="4" style="width:100%; padding:10px; border:1px solid var(--border); border-radius:8px; font-size:12px; outline:none; resize:vertical;" placeholder="Müşterilere verilecek selamlar, öneri stili ve mağaza kuralları..."></textarea>
        </div>
      </div>

      <!-- Tab 2: API Keys -->
      <div id="tabContentApi" style="display:none;" hidden>
        <div class="form-group" style="margin-bottom:14px;">
          <label>Gemini AI API Key</label>
          <input type="password" id="sysGeminiApiKey" placeholder="AIzaSy...">
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label>Instagram / Facebook Page Access Token</label>
          <input type="password" id="sysFbAccessToken" placeholder="EAA...">
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label>Google Sheet Spreadsheet ID</label>
          <input type="text" id="sysGoogleSheetId" placeholder="1BxiMVs0XRra5nFMdAcB...">
        </div>

        <div class="form-group" style="margin-bottom:14px;">
          <label>Telegram Bildirim Bot Token & Chat ID</label>
          <input type="text" id="sysTelegramToken" placeholder="bot_token:chat_id">
        </div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid var(--border); padding-top:15px; margin-top:15px;">
        <button class="btn btn-secondary" onclick="closeSystemSettingsModal()">Vazgeç</button>
        <button class="btn btn-primary" onclick="saveSystemSettingsModal()">
          <i class="fa-solid fa-floppy-disk"></i> Ayarları Kaydet
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const btnClose = document.getElementById('btnCloseSystemSettingsModal');
  if (btnClose) btnClose.onclick = () => closeSystemSettingsModal();

  return modal;
}

function switchSettingsTab(tabName) {
  const tabAi = document.getElementById('tabContentAi');
  const tabApi = document.getElementById('tabContentApi');
  const btnAi = document.getElementById('tabBtnAiCustom');
  const btnApi = document.getElementById('tabBtnApiConfig');

  if (tabName === 'ai') {
    if (tabAi) tabAi.style.display = 'block';
    if (tabApi) tabApi.style.display = 'none';
    if (btnAi) { btnAi.className = 'btn btn-sm btn-primary'; }
    if (btnApi) { btnApi.className = 'btn btn-sm btn-secondary'; }
  } else {
    if (tabAi) tabAi.style.display = 'none';
    if (tabApi) tabApi.style.display = 'block';
    if (btnAi) { btnAi.className = 'btn btn-sm btn-secondary'; }
    if (btnApi) { btnApi.className = 'btn btn-sm btn-primary'; }
  }
}

function openSystemSettingsModal() {
  const modal = getOrCreateSystemSettingsModal();
  modal.style.display = 'flex';
  loadSystemSettingsIntoModal();
}

function closeSystemSettingsModal() {
  const modal = document.getElementById('systemSettingsModal');
  if (modal) modal.style.display = 'none';
}

let loadedAiProvider = null;

function handleAiProviderChange() {
  const providerInput = document.getElementById('sysAiProvider');
  const apiKeyInput = document.getElementById('sysAiApiKey');
  const clearApiKeyInput = document.getElementById('sysClearAiApiKey');
  const apiKeyStatus = document.getElementById('sysAiApiKeyStatus');
  if (!providerInput || !apiKeyInput) return;
  apiKeyInput.value = '';
  if (clearApiKeyInput) clearApiKeyInput.checked = false;
  if (loadedAiProvider && providerInput.value !== loadedAiProvider) {
    apiKeyInput.placeholder = `${providerInput.value === 'gemini' ? 'Gemini' : 'OpenAI'} API anahtarını girin`;
    if (apiKeyStatus) {
      apiKeyStatus.textContent = '⚠ Sağlayıcı değiştirildi. Yeni sağlayıcının API anahtarını girip kaydedin; mevcut kayıt henüz değiştirilmedi.';
      apiKeyStatus.style.color = '#fbbf24';
    }
  }
}

async function loadSystemSettingsIntoModal() {
  try {
    const data = await apiFetch(`${API_BASE}/api/settings`);
    if (data.success && data.settings) {
      const s = data.settings;
      if (document.getElementById('sysBotTone')) document.getElementById('sysBotTone').value = s.bot_tone || 'luxury';
      if (document.getElementById('sysBotSystemPrompt')) document.getElementById('sysBotSystemPrompt').value = s.bot_system_prompt || '';
      const providerInput = document.getElementById('sysAiProvider');
      loadedAiProvider = s.ai_provider || 'openai';
      if (providerInput) {
        providerInput.value = loadedAiProvider;
        providerInput.onchange = handleAiProviderChange;
      }
      const apiKeyInput = document.getElementById('sysAiApiKey');
      const clearApiKeyInput = document.getElementById('sysClearAiApiKey');
      const configured = s.ai_api_key_configured === '1';
      if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.placeholder = configured
          ? '••••••••••••••••  Kayıtlı — değiştirmek için yeni anahtar girin'
          : 'Henüz anahtar yok — yeni API anahtarını girin';
      }
      if (clearApiKeyInput) {
        clearApiKeyInput.checked = false;
        clearApiKeyInput.disabled = !configured;
      }
      const apiKeyStatus = document.getElementById('sysAiApiKeyStatus');
      if (apiKeyStatus) {
        apiKeyStatus.textContent = configured ? '✓ API anahtarı kayıtlı ve şifreli olarak korunuyor.' : '⚠ Bu mağaza için API anahtarı henüz tanımlanmamış.';
        apiKeyStatus.style.color = configured ? '#34d399' : '#fbbf24';
        apiKeyStatus.style.fontWeight = '700';
      }
    }
  } catch (e) {}
}

async function saveSystemSettingsModal() {
  await saveSystemSettingsPage();
  closeSystemSettingsModal();
}

async function saveAiConnectionSettings() {
  const provider = document.getElementById('sysAiProvider')?.value || 'openai';
  const aiApiKey = document.getElementById('sysAiApiKey')?.value?.trim() || '';
  const clearAiApiKey = Boolean(document.getElementById('sysClearAiApiKey')?.checked);
  const looksLikeOpenAIKey = /^sk-[A-Za-z0-9_-]+$/.test(aiApiKey);
  const looksLikeGeminiKey = /^(?:AIza[A-Za-z0-9_-]+|AQ\.[A-Za-z0-9._-]+)$/.test(aiApiKey);
  if (aiApiKey && provider === 'openai' && looksLikeGeminiKey) {
    showToast('❌ Gemini anahtarı OpenAI sağlayıcısına kaydedilemez.', 'error');
    return;
  }
  if (aiApiKey && provider === 'gemini' && looksLikeOpenAIKey) {
    showToast('❌ OpenAI anahtarı Gemini sağlayıcısına kaydedilemez.', 'error');
    return;
  }
  if (loadedAiProvider && provider !== loadedAiProvider && !aiApiKey && !clearAiApiKey) {
    showToast(`❌ ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} için yeni API anahtarını girin.`, 'error');
    return;
  }
  if (!aiApiKey && !clearAiApiKey && document.getElementById('sysAiApiKeyStatus')?.textContent?.includes('henüz')) {
    showToast('❌ Lütfen seçtiğiniz sağlayıcıya ait API anahtarını girin.', 'error');
    return;
  }
  try {
    const data = await apiFetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      body: JSON.stringify({ settings: { ai_provider: provider }, aiApiKey, clearAiApiKey })
    });
    if (!data.success) throw new Error(data.error || 'API ayarları kaydedilemedi.');
    showToast('✅ Mağazaya özel API ayarları kaydedildi.', 'success');
    await loadSystemSettingsIntoModal();
  } catch (error) {
    showToast(`❌ ${error.message || 'API ayarları kaydedilemedi.'}`, 'error');
  }
}

async function savePersonaSettings() {
  const settings = {
    bot_tone: document.getElementById('sysBotTone')?.value || 'luxury',
    bot_system_prompt: document.getElementById('sysBotSystemPrompt')?.value || ''
  };
  try {
    const data = await apiFetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      body: JSON.stringify({ settings })
    });
    if (!data.success) throw new Error(data.error || 'Persona ayarları kaydedilemedi.');
    showToast('✅ Persona ve konuşma ayarları kaydedildi.', 'success');
    await loadSystemSettingsIntoModal();
  } catch (error) {
    showToast(`❌ ${error.message || 'Persona ayarları kaydedilemedi.'}`, 'error');
  }
}

async function saveSystemSettingsPage() {
  const payload = {
    bot_tone: document.getElementById('sysBotTone')?.value || 'luxury',
    bot_system_prompt: document.getElementById('sysBotSystemPrompt')?.value || '',
  };
  const aiProviderInput = document.getElementById('sysAiProvider');
  if (aiProviderInput) payload.ai_provider = aiProviderInput.value || 'openai';
  const aiApiKey = document.getElementById('sysAiApiKey')?.value?.trim() || '';
  const clearAiApiKey = Boolean(document.getElementById('sysClearAiApiKey')?.checked);

  try {
    const data = await apiFetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      body: JSON.stringify({ settings: payload, aiApiKey, clearAiApiKey })
    });
    if (data.success) {
      showToast('✅ Yapay zekâ sağlayıcısı ve mağaza ayarları kaydedildi.', 'success');
      await loadSystemSettingsIntoModal();
    } else {
      showToast(`❌ Hata: ${data.error || 'Ayarlar kaydedilemedi'}`, 'error');
    }
  } catch (e) {
    showToast('Ayarlar kaydedilirken hata oluştu.', 'error');
  }
}


// ESNEK VERİ KAYNAĞI & ALAN EŞLEŞTİRME MOTORU
const dataImportState = {
  sourceType: 'csv',
  sourceName: '',
  content: '',
  sheetUrl: '',
  headers: [],
  mapping: {},
  options: {},
  previewToken: '',
  profiles: []
};

const importFieldLabels = {
  productCode: 'Ürün Kodu / SKU', shortCode: 'Kısa Kod', name: 'Ürün Adı', size: 'Beden / Numara',
  color: 'Renk', price: 'Fiyat', stock: 'Stok', category: 'Kategori', wpLink: 'Ürün Bağlantısı', mediaLink: 'Görsel Bağlantısı',
  instagramMediaId: 'Instagram Media ID'
};

function setDataSourceType(type) {
  if (type !== 'file') dataImportState.sourceType = type;
  else if (!['csv', 'json'].includes(dataImportState.sourceType)) dataImportState.sourceType = 'csv';
  document.querySelectorAll('[data-import-source]').forEach(button => button.classList.toggle('active', button.dataset.importSource === type));
  document.querySelectorAll('[data-import-panel]').forEach(panel => panel.hidden = panel.dataset.importPanel !== type);
}

async function handleImportFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 1800000) {
    showToast('Dosya en fazla 1,8 MB olabilir.', 'error');
    input.value = '';
    return;
  }
  dataImportState.sourceName = file.name;
  dataImportState.sourceType = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  dataImportState.content = await file.text();
  document.getElementById('selectedImportFile').textContent = `${file.name} • ${(file.size / 1024).toFixed(1)} KB`;
  setDataSourceType('file');
}

function currentImportMapping() {
  const mapping = {};
  document.querySelectorAll('[data-mapping-field]').forEach(select => {
    if (select.value) mapping[select.dataset.mappingField] = select.value;
  });
  return mapping;
}

function currentImportOptions() {
  return {
    defaultSize: document.getElementById('importDefaultSize')?.value || 'STANDART',
    priceMultiplier: Number(document.getElementById('importPriceMultiplier')?.value || 1),
    stockMultiplier: Number(document.getElementById('importStockMultiplier')?.value || 1)
  };
}

function renderImportMapping(headers, mapping) {
  const container = document.getElementById('importMappingGrid');
  if (!container) return;
  container.innerHTML = Object.entries(importFieldLabels).map(([field, label]) => `
    <div class="import-map-row">
      <div><strong>${escapeHtml(label)}</strong>${['productCode', 'name', 'price'].includes(field) ? '<span class="required-dot">*</span>' : ''}</div>
      <i data-lucide="arrow-left-right" size="15"></i>
      <select data-mapping-field="${field}">
        <option value="">Eşleştirme yok</option>
        ${headers.map(header => `<option value="${escapeHtml(header)}" ${mapping[field] === header ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}
      </select>
    </div>
  `).join('');
  document.getElementById('importMappingSection').hidden = false;
  if (window.lucide) lucide.createIcons();
}

function renderImportPreview(data) {
  const summary = document.getElementById('importPreviewSummary');
  summary.innerHTML = `
    <div class="import-stat"><span>Toplam</span><strong>${data.totalRows}</strong></div>
    <div class="import-stat success"><span>Hazır</span><strong>${data.validCount}</strong></div>
    <div class="import-stat warning"><span>Uyarı</span><strong>${data.warningCount}</strong></div>
    <div class="import-stat error"><span>Hatalı</span><strong>${data.invalidCount}</strong></div>`;
  const body = document.getElementById('importPreviewBody');
  body.innerHTML = data.sampleRows.length ? data.sampleRows.map(row => `
    <tr><td>${row.sourceRow}</td><td><span class="code-tag">${escapeHtml(row.productCode)}</span></td><td>${escapeHtml(row.name)}</td>
    <td>${escapeHtml(row.size)}</td><td>${Number(row.stock).toLocaleString('tr-TR')}</td><td>${Number(row.price).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</td><td>${escapeHtml(row.instagramMediaId || '-')}</td></tr>
  `).join('') : '<tr><td colspan="7" class="empty-cell">Geçerli kayıt bulunamadı.</td></tr>';
  const issueBox = document.getElementById('importIssues');
  const issues = [...data.errors.map(item => ({ ...item, type: 'error' })), ...data.warnings.map(item => ({ ...item, type: 'warning' }))];
  issueBox.hidden = !issues.length;
  issueBox.innerHTML = issues.slice(0, 30).map(item => `<div class="import-issue ${item.type}"><strong>Satır ${item.row}</strong><span>${escapeHtml(item.messages.join(' '))}</span></div>`).join('');
  document.getElementById('importPreviewSection').hidden = false;
  const commitButton = document.getElementById('btnCommitImport');
  commitButton.disabled = data.validCount === 0;
  commitButton.textContent = `${data.validCount} Geçerli Kaydı İçe Aktar`;
}

async function analyzeDataSource(useCurrentMapping = false) {
  const button = document.getElementById('btnAnalyzeImport');
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Veri analiz ediliyor...';
  try {
    let payload;
    if (dataImportState.sourceType === 'google_sheets') {
      const sheetUrl = document.getElementById('importSheetUrl').value.trim();
      if (!sheetUrl) throw new Error('Google Sheets bağlantısını girin.');
      dataImportState.sheetUrl = sheetUrl;
      payload = { sourceType: 'google_sheets', sheetUrl };
    } else if (dataImportState.sourceType === 'json_paste') {
      dataImportState.content = document.getElementById('importJsonText').value.trim();
      dataImportState.sourceName = 'Yapıştırılan JSON';
      payload = { sourceType: 'json', sourceName: dataImportState.sourceName, content: dataImportState.content };
    } else {
      if (!dataImportState.content) throw new Error('Önce CSV veya JSON dosyası seçin.');
      payload = { sourceType: dataImportState.sourceType, sourceName: dataImportState.sourceName, content: dataImportState.content };
    }
    const profileId = Number(document.getElementById('importProfileSelect')?.value || 0);
    if (profileId && !useCurrentMapping) payload.profileId = profileId;
    if (useCurrentMapping) {
      payload.mapping = currentImportMapping();
      payload.options = currentImportOptions();
    }
    const data = await apiFetch('/api/data-import/analyze', { method: 'POST', body: JSON.stringify(payload) });
    Object.assign(dataImportState, { headers: data.headers, mapping: data.mapping, options: data.options, previewToken: data.previewToken });
    renderImportMapping(data.headers, data.mapping);
    document.getElementById('importDefaultSize').value = data.options.defaultSize || 'STANDART';
    document.getElementById('importPriceMultiplier').value = data.options.priceMultiplier || 1;
    document.getElementById('importStockMultiplier').value = data.options.stockMultiplier || 1;
    renderImportPreview(data);
    showToast(`${data.validCount} kayıt içe aktarmaya hazır. Önizlemeyi kontrol edin.`, data.invalidCount ? 'warning' : 'success');
  } catch (error) {
    showToast(error.message || 'Veri kaynağı analiz edilemedi.', 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="scan-search"></i> Veriyi Analiz Et';
    if (window.lucide) lucide.createIcons();
  }
}

async function commitDataImport() {
  if (!dataImportState.previewToken) return showToast('Önce veriyi analiz edin.', 'warning');
  const button = document.getElementById('btnCommitImport');
  button.disabled = true;
  try {
    const profileName = document.getElementById('importProfileName').value.trim();
    const data = await apiFetch('/api/data-import/commit', {
      method: 'POST',
      body: JSON.stringify({ previewToken: dataImportState.previewToken, saveProfile: Boolean(profileName), profileName })
    });
    showToast(data.message, 'success');
    dataImportState.previewToken = '';
    button.textContent = 'İçe Aktarma Tamamlandı';
    await Promise.all([loadImportProfiles(), loadImportHistory()]);
  } catch (error) {
    showToast(error.message || 'İçe aktarma tamamlanamadı.', 'error');
    button.disabled = false;
  }
}

async function loadImportProfiles() {
  const select = document.getElementById('importProfileSelect');
  if (!select) return;
  try {
    const data = await apiFetch('/api/data-import/profiles');
    dataImportState.profiles = data.profiles || [];
    select.innerHTML = '<option value="">Otomatik eşleştir</option>' + dataImportState.profiles.map(profile => `<option value="${profile.id}">${escapeHtml(profile.name)}</option>`).join('');
  } catch {}
}

async function loadImportHistory() {
  const body = document.getElementById('importHistoryBody');
  if (!body) return;
  try {
    const data = await apiFetch('/api/data-import/history');
    body.innerHTML = data.jobs?.length ? data.jobs.map(job => `
      <tr><td>${escapeHtml(job.sourceName || job.sourceType)}</td><td>${escapeHtml(job.profileName || 'Otomatik')}</td>
      <td><span class="status-badge in-stock">Tamamlandı</span></td><td>${job.insertedRows}</td><td>${job.updatedRows}</td><td>${new Date(String(job.completedAt || job.createdAt).replace(' ', 'T') + 'Z').toLocaleString('tr-TR')}</td></tr>
    `).join('') : '<tr><td colspan="6" class="empty-cell">Henüz içe aktarma yapılmadı.</td></tr>';
  } catch { body.innerHTML = '<tr><td colspan="6" class="empty-cell">Geçmiş yüklenemedi.</td></tr>'; }
}

function initializeDataSourcesPage() {
  if (!document.getElementById('dataSourcesPage')) return;
  document.querySelectorAll('[data-import-source]').forEach(button => button.addEventListener('click', () => setDataSourceType(button.dataset.importSource)));
  document.getElementById('importFile')?.addEventListener('change', event => handleImportFile(event.target));
  document.getElementById('btnAnalyzeImport')?.addEventListener('click', () => analyzeDataSource(false));
  document.getElementById('btnReanalyzeMapping')?.addEventListener('click', () => analyzeDataSource(true));
  document.getElementById('btnCommitImport')?.addEventListener('click', commitDataImport);
  setDataSourceType('file');
  loadImportProfiles();
  loadImportHistory();
}

// INSTAGRAM GÖNDERİ KATALOĞU (YORUMLARA ERİŞMEDEN)
const instagramMediaState = { media: [], nextCursor: '', query: '', selectedMediaId: '' };

function renderInstagramMediaCatalog() {
  const grid = document.getElementById('instagramMediaGrid');
  if (!grid) return;
  const query = instagramMediaState.query.toLocaleLowerCase('tr-TR');
  const items = instagramMediaState.media.filter(item => {
    const searchable = [item.id, item.caption, item.mediaType, ...(item.products || []).flatMap(product => [product.productCode, product.shortCode, product.name])]
      .join(' ').toLocaleLowerCase('tr-TR');
    return searchable.includes(query);
  });
  document.getElementById('instagramMediaCount').textContent = `${items.length} gönderi gösteriliyor`;
  grid.innerHTML = items.length ? items.map(item => {
    const previewUrl = item.thumbnailUrl || item.mediaUrl || '';
    const products = Array.isArray(item.products) ? item.products : [];
    const productCodes = [...new Set(products.map(product => product.productCode).filter(Boolean))];
    const mapping = productCodes.length
      ? `<div class="ig-media-mapping linked"><i data-lucide="link" size="13"></i><span>${productCodes.map(escapeHtml).join(', ')}</span></div>`
      : '<div class="ig-media-mapping"><i data-lucide="unlink" size="13"></i><span>Veri setinde eşleşen ürün yok</span></div>';
    return `
      <article class="ig-media-card" data-instagram-media-id="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="Gönderi detayını ve ürün atamasını aç">
        <div class="ig-media-preview">${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="Instagram gönderisi" loading="lazy">` : '<i data-lucide="image-off" size="34"></i>'}<span class="ig-media-open-hint"><i data-lucide="maximize-2" size="13"></i></span></div>
        <div class="ig-media-body">
          <div class="ig-media-top"><span class="status-badge in-stock">${escapeHtml(item.mediaProductType || item.mediaType || 'POST')}</span><small>${item.timestamp ? new Date(item.timestamp).toLocaleDateString('tr-TR') : '-'}</small></div>
          <div class="ig-media-id"><span>MEDIA ID</span><code>${escapeHtml(item.id)}</code></div>
          ${mapping}
        </div>
      </article>`;
  }).join('') : '<div class="ig-media-empty"><i data-lucide="images" size="34"></i><strong>Gönderi bulunamadı</strong><span>Instagram bağlantısını ve arama metnini kontrol edin.</span></div>';
  document.getElementById('btnLoadMoreInstagramMedia').hidden = !instagramMediaState.nextCursor;
  if (window.lucide) lucide.createIcons();
}

async function loadInstagramMedia(reset = true) {
  const refreshButton = document.getElementById('btnRefreshInstagramMedia');
  const loadMoreButton = document.getElementById('btnLoadMoreInstagramMedia');
  if (!document.getElementById('instagramMediaPage')) return;
  if (reset) {
    refreshButton.disabled = true;
    refreshButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Senkronize Ediliyor';
  } else loadMoreButton.disabled = true;
  try {
    const cursor = reset ? '' : instagramMediaState.nextCursor;
    const data = await apiFetch(`/api/integrations/instagram/media${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
    const incoming = Array.isArray(data.media) ? data.media : [];
    if (reset) instagramMediaState.media = incoming;
    else {
      const byId = new Map(instagramMediaState.media.map(item => [item.id, item]));
      incoming.forEach(item => byId.set(item.id, item));
      instagramMediaState.media = [...byId.values()];
    }
    instagramMediaState.nextCursor = data.nextCursor || '';
    const status = document.getElementById('instagramMediaSyncStatus');
    status.className = `ig-sync-note${data.source === 'cache' ? ' warning' : ''}`;
    status.textContent = data.warning || `${instagramMediaState.media.length} gönderi Instagram’dan senkronize edildi. Yorum verilerine erişilmedi.`;
    renderInstagramMediaCatalog();
  } catch (error) {
    const status = document.getElementById('instagramMediaSyncStatus');
    status.className = 'ig-sync-note error';
    status.textContent = error.message || 'Instagram gönderileri alınamadı.';
    instagramMediaState.media = [];
    instagramMediaState.nextCursor = '';
    renderInstagramMediaCatalog();
  } finally {
    refreshButton.disabled = false;
    refreshButton.innerHTML = '<i data-lucide="refresh-cw" size="14"></i>Gönderileri Yenile';
    loadMoreButton.disabled = false;
    if (window.lucide) lucide.createIcons();
  }
}

async function copyInstagramMediaId(mediaId) {
  try {
    await navigator.clipboard.writeText(mediaId);
    showToast(`Media ID kopyalandı: ${mediaId}`, 'success');
  } catch {
    showToast('Media ID kopyalanamadı.', 'error');
  }
}

function closeInstagramMediaDetail() {
  const modal = document.getElementById('instagramMediaDetailModal');
  modal?.classList.remove('open');
  document.body.style.overflow = '';
  instagramMediaState.selectedMediaId = '';
}

function getInstagramProductFamilies(products) {
  const families = new Map();
  (Array.isArray(products) ? products : []).forEach(product => {
    const shortCode = String(product.shortCode || '').trim().toUpperCase();
    if (!shortCode) return;
    if (!families.has(shortCode)) families.set(shortCode, { shortCode, name: product.name || '', productCodes: [] });
    if (product.productCode && !families.get(shortCode).productCodes.includes(product.productCode)) {
      families.get(shortCode).productCodes.push(product.productCode);
    }
  });
  return [...families.values()].sort((a, b) => a.shortCode.localeCompare(b.shortCode, 'tr'));
}

function renderInstagramMediaCurrentMapping(item) {
  const current = document.getElementById('instagramMediaDetailCurrent');
  if (!current) return;
  const products = Array.isArray(item?.products) ? item.products : [];
  const productCodes = [...new Set(products.map(product => product.productCode).filter(Boolean))];
  current.innerHTML = productCodes.length
    ? `<div class="ig-media-mapping linked"><i data-lucide="link" size="13"></i><span>Bağlı ürünler: ${productCodes.map(escapeHtml).join(', ')}</span></div>`
    : '<div class="ig-media-mapping"><i data-lucide="unlink" size="13"></i><span>Henüz bir ürüne atanmamış</span></div>';
}

async function openInstagramMediaDetail(mediaId) {
  const item = instagramMediaState.media.find(media => String(media.id) === String(mediaId));
  const modal = document.getElementById('instagramMediaDetailModal');
  if (!item || !modal) return;
  instagramMediaState.selectedMediaId = String(item.id);

  document.getElementById('instagramMediaDetailId').textContent = item.id;
  document.getElementById('instagramMediaDetailCaption').textContent = item.caption || 'Açıklama bulunmuyor.';
  document.getElementById('instagramMediaDetailType').textContent = item.mediaProductType || item.mediaType || 'POST';
  document.getElementById('instagramMediaDetailDate').textContent = item.timestamp ? new Date(item.timestamp).toLocaleDateString('tr-TR') : '-';
  const previewUrl = item.thumbnailUrl || item.mediaUrl || '';
  document.getElementById('instagramMediaDetailImage').innerHTML = previewUrl
    ? `<img src="${escapeHtml(previewUrl)}" alt="Instagram gönderisi">`
    : '<i data-lucide="image-off" size="42"></i>';
  const postLink = document.getElementById('btnOpenInstagramMediaPost');
  postLink.hidden = !item.permalink;
  if (item.permalink) postLink.href = item.permalink;
  renderInstagramMediaCurrentMapping(item);

  if (!state.products.length) {
    try {
      const stocks = await apiFetch('/api/stocks');
      state.products = Array.isArray(stocks.stocks) ? stocks.stocks : [];
    } catch (error) {
      showToast('Ürün kodları yüklenemedi.', 'error');
    }
  }
  const currentShortCode = String(item.products?.[0]?.shortCode || '').trim().toUpperCase();
  const select = document.getElementById('instagramMediaProductSelect');
  const families = getInstagramProductFamilies(state.products);
  select.innerHTML = '<option value="">Ürün kodu seçin</option>' + families.map(family => {
    const variants = family.productCodes.length ? ` · ${family.productCodes.join(', ')}` : '';
    return `<option value="${escapeHtml(family.shortCode)}"${family.shortCode === currentShortCode ? ' selected' : ''}>${escapeHtml(family.shortCode)} — ${escapeHtml(family.name)}${escapeHtml(variants)}</option>`;
  }).join('');
  select.disabled = !families.length;
  document.getElementById('btnAssignInstagramMedia').disabled = !families.length;
  document.getElementById('btnUnassignInstagramMedia').disabled = !item.products?.length;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (window.lucide) lucide.createIcons();
}

async function saveInstagramMediaAssignment(remove = false) {
  const mediaId = instagramMediaState.selectedMediaId;
  const select = document.getElementById('instagramMediaProductSelect');
  const shortCode = remove ? '' : String(select?.value || '').trim().toUpperCase();
  if (!mediaId) return;
  if (!remove && !shortCode) {
    showToast('Lütfen atanacak ürün kodunu seçin.', 'warning');
    return;
  }
  const button = document.getElementById(remove ? 'btnUnassignInstagramMedia' : 'btnAssignInstagramMedia');
  button.disabled = true;
  try {
    const data = await apiFetch(`/api/integrations/instagram/media/${encodeURIComponent(mediaId)}/assignment`, {
      method: 'PUT', body: JSON.stringify({ shortCode })
    });
    instagramMediaState.media.forEach(item => {
      if (String(item.id) === mediaId) item.products = Array.isArray(data.products) ? data.products : [];
      else if (shortCode) item.products = (item.products || []).filter(product => String(product.shortCode || '').toUpperCase() !== shortCode);
    });
    state.products.forEach(product => {
      if (String(product.instagramMediaId || '') === mediaId) product.instagramMediaId = '';
      if (shortCode && String(product.shortCode || '').toUpperCase() === shortCode) product.instagramMediaId = mediaId;
    });
    renderInstagramMediaCatalog();
    showToast(data.message || 'Gönderi eşleştirmesi güncellendi.', 'success');
    closeInstagramMediaDetail();
  } catch (error) {
    showToast(error.message || 'Ürün ataması kaydedilemedi.', 'error');
  } finally {
    button.disabled = false;
  }
}

function initializeInstagramMediaPage() {
  if (!document.getElementById('instagramMediaPage')) return;
  document.getElementById('btnRefreshInstagramMedia')?.addEventListener('click', () => loadInstagramMedia(true));
  document.getElementById('btnLoadMoreInstagramMedia')?.addEventListener('click', () => loadInstagramMedia(false));
  document.getElementById('instagramMediaSearch')?.addEventListener('input', event => {
    instagramMediaState.query = event.target.value || '';
    renderInstagramMediaCatalog();
  });
  document.getElementById('instagramMediaGrid')?.addEventListener('click', event => {
    const card = event.target.closest('[data-instagram-media-id]');
    if (card) openInstagramMediaDetail(card.dataset.instagramMediaId);
  });
  document.getElementById('instagramMediaGrid')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('[data-instagram-media-id]');
    if (!card) return;
    event.preventDefault();
    openInstagramMediaDetail(card.dataset.instagramMediaId);
  });
  document.getElementById('btnCloseInstagramMediaDetail')?.addEventListener('click', closeInstagramMediaDetail);
  document.getElementById('instagramMediaDetailModal')?.addEventListener('click', event => {
    if (event.target.id === 'instagramMediaDetailModal') closeInstagramMediaDetail();
  });
  document.getElementById('btnCopyInstagramMediaDetailId')?.addEventListener('click', () => copyInstagramMediaId(instagramMediaState.selectedMediaId));
  document.getElementById('btnAssignInstagramMedia')?.addEventListener('click', () => saveInstagramMediaAssignment(false));
  document.getElementById('btnUnassignInstagramMedia')?.addEventListener('click', () => saveInstagramMediaAssignment(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('instagramMediaDetailModal')?.classList.contains('open')) closeInstagramMediaDetail();
  });
  loadInstagramMedia(true);
}

// ESKİ GOOGLE SHEET DIŞA AKTARMA DESTEĞİ
async function importFromCustomGoogleSheet() {
  const inputElem = document.getElementById('customSheetImportUrl') || document.getElementById('sysGoogleSheetId');
  if (!inputElem) return;

  let val = inputElem.value.trim();
  if (!val) {
    showToast('Lütfen Google Sheet ID veya paylaşım bağlantısını girin.', 'error');
    return;
  }

  let sheetId = val;
  const match = val.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    sheetId = match[1];
  }

  const btn = document.getElementById('btnImportSheet');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Tablo Çekiliyor...';
  }

  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
    const res = await fetch(csvUrl);
    
    if (!res.ok) {
      throw new Error('Google Sheet verisi okunamadı. Lütfen tablonuzun "Bağlantıya sahip herkes görebilir" olarak ayarlandığından emin olun.');
    }

    const csvText = await res.text();
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length <= 1) {
      throw new Error('Google Sheet tablosu boş veya geçersiz formatta.');
    }

    const importedProducts = [];
    const storeName = getActiveStoreName();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length >= 2) {
        const sc = (cols[0] || 'STK').toUpperCase();
        const name = cols[1] || 'İsimsiz Ürün';
        const color = cols[2] || 'Standart';
        const size = (cols[3] || 'M').toUpperCase();
        const stock = Number(cols[4]) || 100;
        const price = Number(cols[5]) || 299;
        const category = cols[6] || 'Genel';
        const code = cols[7] ? cols[7].toUpperCase() : `${sc}-${size}`;

        importedProducts.push({
          shortCode: sc,
          productCode: code,
          name: name,
          color: color,
          size: size,
          stock: stock,
          price: price,
          category: category,
          storeName: storeName
        });
      }
    }

    if (importedProducts.length === 0) {
      throw new Error('Tablodan aktarılacak geçerli ürün verisi okunamadı.');
    }

    const currentProducts = getStoreProducts();
    const mergedProducts = [...importedProducts, ...currentProducts];
    saveStoreProducts(mergedProducts);

    showToast(`🎉 Başarılı! Google Sheet tablosundan ${importedProducts.length} adet stok ürünü veritabanınıza içe aktarıldı!`, 'success');
    
    setTimeout(() => {
      window.location.href = 'stock';
    }, 1200);

  } catch (err) {
    showToast(`❌ İçe Aktarma Hatası: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-file-import"></i> Google Sheet\'ten Stok İçe Aktar (Import Products)';
    }
  }
}

function exportStoreDataToCSV() {
  const storeProducts = getStoreProducts();
  if (storeProducts.length === 0) {
    showToast('İndirilecek stok verisi bulunmuyor.', 'info');
    return;
  }

  let csvContent = 'data:text/csv;charset=utf-8,KODU,ISIM,RENK,BEDEN,STOK,FIYAT,KATEGORI\n';
  storeProducts.forEach(p => {
    const row = [
      p.shortCode || '',
      `"${p.name || ''}"`,
      `"${p.color || ''}"`,
      p.size || '',
      p.stock || 0,
      p.price || 0,
      `"${p.category || ''}"`
    ].join(',');
    csvContent += row + '\n';
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `${getActiveStoreName()}_stok_verileri.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('📥 Mağaza stok verileriniz CSV dosyası olarak indirildi.', 'success');
}

// MAĞAZAYA ÖZEL WEBHOOK VE META ENTEGRASYON SÜRÜCÜSÜ
let realVerifyToken = '';

async function loadStoreWebhookDetails() {
  const input = document.getElementById('storeWebhookUrl');
  const tokenInput = document.getElementById('storeVerifyTokenInput');
  const pageIdInput = document.getElementById('metaPageIdInput');
  const igAccountInput = document.getElementById('igAccountIdInput');
  const igUserInput = document.getElementById('igUsernameInput');
  const lastEvtElem = document.getElementById('lastWebhookEventTime');
  const statusBadge = document.getElementById('metaStatusBadge');

  if (!input && !tokenInput) return;
  const origin = window.location.origin || 'http://localhost:3000';

  try {
    const data = await apiFetch('/api/stores/webhook-info');
    if (data && data.success) {
      if (input) input.value = data.webhookUrl || `${origin}/api/webhook/${data.slug}`;
      realVerifyToken = data.verifyToken || '';

      if (tokenInput && tokenInput.type === 'password') {
        tokenInput.value = '••••••••••••••••••••••••';
      } else if (tokenInput && tokenInput.type === 'text') {
        tokenInput.value = realVerifyToken;
      }

      const globalInput = document.getElementById('globalWebhookUrl');
      if (globalInput) globalInput.value = `${origin}/webhook/instagram`;

      if (pageIdInput) pageIdInput.value = data.metaPageId || '';
      if (igAccountInput) igAccountInput.value = data.instagramAccountId || '';
      if (igUserInput) igUserInput.value = data.instagramUsername || '';

      if (statusBadge) {
        if (data.instagramConnected) {
          statusBadge.className = 'status-badge in-stock';
          statusBadge.innerHTML = 'Instagram Bağlı';
        } else {
          statusBadge.className = 'status-badge out-stock';
          statusBadge.innerHTML = 'Instagram Bağlı Değil';
        }
      }

      const oauthStatus = document.getElementById('instagramOAuthStatus');
      const connectButton = document.getElementById('btnConnectInstagram');
      const disconnectButton = document.getElementById('btnDisconnectInstagram');
      if (oauthStatus) {
        if (data.instagramConnected) {
          oauthStatus.textContent = `Bağlı: @${data.instagramUsername || 'instagram hesabı'} • DM ve profil gönderileri erişimi aktif`;
          oauthStatus.style.color = '#34d399';
        } else {
          oauthStatus.textContent = 'Henüz Instagram hesabı bağlanmadı.';
          oauthStatus.style.color = '#94a3b8';
        }
      }
      if (connectButton) {
        connectButton.style.display = data.instagramConnected ? 'none' : 'inline-flex';
        connectButton.innerHTML = '<i class="fa-brands fa-instagram"></i> Instagram\'ı Bağla';
      }
      if (disconnectButton) disconnectButton.style.display = data.instagramConnected ? 'inline-flex' : 'none';

      if (lastEvtElem) {
        lastEvtElem.textContent = data.lastWebhookAt || 'Henüz event gelmedi';
      }
    }
  } catch (e) {
    console.warn('[loadStoreWebhookDetails Notice]:', e.message);
  }
}

async function updateInstagramConnectionStatus() {
  try {
    const data = await apiFetch('/api/integration/status');
    setSyncStatus(
      data?.instagramConnected ? 'success' : 'error',
      data?.instagramConnected ? 'Instagram Bağlı' : 'Instagram Bağlı Değil'
    );
  } catch (error) {
    setSyncStatus('error', 'Instagram Bağlantısı Kontrol Edilemedi');
  }
}

async function connectInstagramOAuth() {
  const button = document.getElementById('btnConnectInstagram');
  try {
    if (button) button.disabled = true;
    const data = await apiFetch('/api/integrations/instagram/connect', { method: 'POST' });
    if (!data?.success || !data.authorizeUrl) throw new Error(data?.error || 'Instagram bağlantısı başlatılamadı.');
    const popup = window.open(data.authorizeUrl, 'instagram_oauth', 'width=600,height=760');
    if (!popup) throw new Error('Açılır pencere engellendi. Tarayıcı izinlerinden pop-up izni verin.');
  } catch (error) {
    showToast(`❌ ${error.message || 'Instagram bağlantısı başlatılamadı.'}`, 'error');
    if (button) button.disabled = false;
  }
}

async function disconnectInstagramOAuth() {
  if (!confirm('Bu mağazanın Instagram bağlantısı kaldırılsın mı?')) return;
  try {
    const data = await apiFetch('/api/integrations/instagram/disconnect', { method: 'POST' });
    if (!data?.success) throw new Error(data?.error || 'Bağlantı kaldırılamadı.');
    showToast('Instagram bağlantısı kaldırıldı.', 'success');
    await loadStoreWebhookDetails();
  } catch (error) {
    showToast(`❌ ${error.message || 'Bağlantı kaldırılamadı.'}`, 'error');
  }
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'instagram-oauth-complete') return;
  if (event.data.success) {
    showToast('Instagram DM ve profil gönderileri başarıyla bağlandı.', 'success');
    loadStoreWebhookDetails();
  }
  const button = document.getElementById('btnConnectInstagram');
  if (button) button.disabled = false;
});

function toggleVerifyTokenVisibility() {
  const tokenInput = document.getElementById('storeVerifyTokenInput');
  const btn = document.getElementById('btnToggleTokenVisibility');
  if (!tokenInput) return;

  if (tokenInput.type === 'password') {
    tokenInput.type = 'text';
    tokenInput.value = realVerifyToken;
    if (btn) btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Gizle';
  } else {
    tokenInput.type = 'password';
    tokenInput.value = '••••••••••••••••••••••••';
    if (btn) btn.innerHTML = '<i class="fa-solid fa-eye"></i> Göster';
  }
}

async function regenerateStoreVerifyToken() {
  if (!confirm('Mağazanıza özel Webhook Verify Token\'ı yenilemek istediğinizden emin misiniz?\n\nYeni token oluşturulduğunda Meta Developer portalında da güncellemeniz gerekecektir.')) return;

  try {
    const data = await apiFetch('/api/stores/webhook-token/regenerate', { method: 'POST' });
    if (data && data.success && data.verifyToken) {
      realVerifyToken = data.verifyToken;
      const tokenInput = document.getElementById('storeVerifyTokenInput');
      if (tokenInput) {
        if (tokenInput.type === 'text') {
          tokenInput.value = realVerifyToken;
        } else {
          tokenInput.value = '••••••••••••••••••••••••';
        }
      }
      showToast('🎉 Webhook Verify Token başarıyla yenilendi!', 'success');
    } else {
      showToast(`❌ Hata: ${data?.error || 'Token yenilenemedi.'}`, 'error');
    }
  } catch (e) {
    showToast(`❌ Hata: ${e.message || 'Token yenilenirken hata oluştu.'}`, 'error');
  }
}

async function saveMetaIntegrationSettings() {
  const pageId = document.getElementById('metaPageIdInput')?.value.trim();
  const igAccountId = document.getElementById('igAccountIdInput')?.value.trim();
  const igUsername = document.getElementById('igUsernameInput')?.value.trim();

  try {
    const data = await apiFetch('/api/integration/meta', {
      method: 'POST',
      body: JSON.stringify({
        metaPageId: pageId,
        instagramAccountId: igAccountId,
        instagramUsername: igUsername
      })
    });
    showToast(data.message || 'Meta entegrasyon ayarları kaydedildi!', 'success');
    loadStoreWebhookDetails();
  } catch (e) {}
}

function copyStoreWebhookUrl() {
  const input = document.getElementById('storeWebhookUrl');
  if (!input) return;
  navigator.clipboard.writeText(input.value);
  showToast('📋 Mağazanıza özel bağımsız Webhook URL kopyalandı!', 'success');
}

// Otomatik Ürün Kodu Önizleme Güncelleyici
function updateProductCodePreview() {
  const shortCodeElem = document.getElementById('shortCode');
  const sizeElem = document.getElementById('sizeInput');
  const codeElem = document.getElementById('productCode');
  if (shortCodeElem && sizeElem && codeElem) {
    const sc = shortCodeElem.value.trim().toUpperCase();
    const sz = sizeElem.value.trim().toUpperCase();
    if (sc && sz) {
      codeElem.value = `${sc}-${sz}`;
    } else if (sc) {
      codeElem.value = `${sc}-...`;
    } else {
      codeElem.value = '';
    }
  }
}

// YENİ ÜRÜN VE STOK GİRİŞİ FORMU SÜRÜCÜSÜ (API via apiFetch with JWT)
async function handleNewProductSubmit(e) {
  if (e) e.preventDefault();
  const shortCodeElem = document.getElementById('shortCode');
  const sizeElem = document.getElementById('sizeInput');
  const codeElem = document.getElementById('productCode');
  const nameElem = document.getElementById('productName');
  const colorElem = document.getElementById('colorInput');
  const stockElem = document.getElementById('stockInput');
  const priceElem = document.getElementById('priceInput');
  const catElem = document.getElementById('categoryInput');
  const instagramMediaIdElem = document.getElementById('instagramMediaIdInput');

  if (!shortCodeElem || !nameElem || !sizeElem) {
    showToast('Lütfen zorunlu alanları doldurun.', 'error');
    return;
  }

  const sc = shortCodeElem.value.toUpperCase().trim();
  const size = sizeElem.value.toUpperCase().trim();
  const code = (codeElem && codeElem.value.trim()) ? codeElem.value.trim().toUpperCase() : `${sc}-${size}`;
  const name = nameElem.value.trim();
  const color = colorElem ? colorElem.value.trim() : 'Standart';
  const stock = Number(stockElem?.value) || 0;
  const price = Number(priceElem?.value) || 299;
  const category = catElem ? catElem.value.trim() : 'Genel';

  if (!sc || !size || !name) {
    showToast('Kısa kod, beden ve ürün ismi alanları zorunludur.', 'error');
    return;
  }
  if (isNaN(stock) || stock < 0) {
    showToast('Geçersiz stok miktarı girdiniz.', 'error');
    return;
  }
  if (isNaN(price) || price < 0) {
    showToast('Geçersiz fiyat girdiniz.', 'error');
    return;
  }

  const newProduct = {
    shortCode: sc,
    productCode: code,
    name: name,
    color: color,
    size: size,
    stock: stock,
    price: price,
    category: category,
    instagramMediaId: instagramMediaIdElem ? instagramMediaIdElem.value.trim() : ''
  };

  const submitBtn = document.getElementById('newProductForm')?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const data = await apiFetch('/api/products', {
      method: 'POST',
      body: JSON.stringify(newProduct)
    });

    if (data && data.success) {
      showToast(`🎉 "${name}" (${data.productCode || code}) mağazanıza başarıyla eklendi!`, 'success');
      const form = document.getElementById('newProductForm');
      if (form) form.reset();
      updateProductCodePreview();
      setTimeout(() => {
        window.location.href = 'stock';
      }, 800);
    } else {
      showToast(`❌ Hata: ${data?.error || 'Ürün kaydedilemedi.'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Hata: ${err.message || 'Sunucu hatası oluştu.'}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadStoreWebhookDetails, 100);
  const npForm = document.getElementById('newProductForm');
  if (npForm) {
    npForm.addEventListener('submit', handleNewProductSubmit);
  }
  const shortCodeElem = document.getElementById('shortCode');
  const sizeElem = document.getElementById('sizeInput');
  if (shortCodeElem) shortCodeElem.addEventListener('input', updateProductCodePreview);
  if (sizeElem) sizeElem.addEventListener('input', updateProductCodePreview);
});

// Master Admin Merchant Application Approval Tools
async function fetchMerchantApplications() {
  const tableBody = document.getElementById('merchantApplicationsTableBody');
  if (!tableBody) return;

  try {
    const data = await apiFetch('/api/master-admin/applications');
    if (data && data.success && Array.isArray(data.applications)) {
      if (data.applications.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 1.5rem; color: #94a3b8;">Henüz mağaza başvurusu bulunmuyor.</td></tr>`;
        return;
      }
      tableBody.innerHTML = data.applications.map(app => {
        let statusBadge = '<span class="status-badge low-stock">⏳ Beklemede</span>';
        if (app.status === 'approved' || app.status === 'active') {
          statusBadge = '<span class="status-badge in-stock">✅ Onaylandı</span>';
        } else if (app.status === 'rejected') {
          statusBadge = '<span class="status-badge out-stock">❌ Reddedildi</span>';
        }

        const actions = (app.status === 'pending') ? `
          <button class="btn btn-sm btn-primary" onclick="approveMerchantApplication(${app.id})"><i class="fa-solid fa-check"></i> Onayla</button>
          <button class="btn btn-sm btn-delete" style="margin-left:4px;" onclick="rejectMerchantApplication(${app.id})"><i class="fa-solid fa-xmark"></i> Reddet</button>
        ` : `<span style="font-size:11px; color:#6b7280;">İşlem Yapıldı</span>`;

        return `
          <tr>
            <td>#${app.id}</td>
            <td><strong>${escapeHtml(app.store_name)}</strong></td>
            <td>${escapeHtml(app.full_name)}</td>
            <td>${escapeHtml(app.email)}</td>
            <td><span class="code-tag">${escapeHtml(app.plan || 'Pro')}</span></td>
            <td>${statusBadge}</td>
            <td>${actions}</td>
          </tr>
        `;
      }).join('');
    }
  } catch (e) {
    if (e.message !== 'FORBIDDEN') {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 1.5rem; color: #ef4444;">Başvurular yüklenirken hata oluştu.</td></tr>`;
    }
  }
}

async function approveMerchantApplication(id) {
  if (!confirm('Bu mağaza başvurusunu onaylamak ve mağazayı aktifleştirmek istiyor musunuz?')) return;
  try {
    const data = await apiFetch(`/api/master-admin/applications/${id}/approve`, { method: 'POST' });
    showToast(data.message || 'Mağaza başvurusu başarıyla onaylandı!', 'success');
    fetchMerchantApplications();
  } catch (e) {}
}

async function rejectMerchantApplication(id) {
  if (!confirm('Bu mağaza başvurusunu reddetmek istediğinizden emin misiniz?')) return;
  try {
    const data = await apiFetch(`/api/master-admin/applications/${id}/reject`, { method: 'POST' });
    showToast(data.message || 'Mağaza başvurusu reddedildi.', 'info');
    fetchMerchantApplications();
  } catch (e) {}
}
