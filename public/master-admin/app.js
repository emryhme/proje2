// Master Admin Platform Console Application Logic

const THEME_STORAGE_KEY = 'iscworks_admin_theme';

function applyMasterTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  const button = document.getElementById('themeToggle');
  if (!button) return;

  const isLight = theme === 'light';
  button.setAttribute('aria-label', isLight ? 'Koyu moda geç' : 'Açık moda geç');
  button.title = isLight ? 'Koyu moda geç' : 'Açık moda geç';
  button.innerHTML = `<i class="fa-solid ${isLight ? 'fa-moon' : 'fa-sun'}"></i>`;
}

function setupMasterThemeToggle() {
  const navbar = document.querySelector('.top-navbar');
  if (!navbar || document.getElementById('themeToggle')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'themeToggle';
  button.className = 'theme-toggle';
  button.addEventListener('click', () => {
    applyMasterTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  const profile = navbar.querySelector('.user-profile');
  navbar.insertBefore(button, profile || null);
  applyMasterTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'dark');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  let icon = 'fa-circle-info text-blue';
  if (type === 'success') icon = 'fa-circle-check text-green';
  if (type === 'warning') icon = 'fa-triangle-exclamation text-amber';
  if (type === 'error') icon = 'fa-circle-xmark text-red';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// Central Interceptor for Master Admin Requests
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('barons_admin_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { ...options, headers });

    if (response.status === 401) {
      localStorage.removeItem('barons_admin_token');
      localStorage.removeItem('barons_admin_user');
      window.location.href = '/master-admin/login.html';
      throw new Error('UNAUTHORIZED');
    }

    if (response.status === 403) {
      showToast('⛔ Master Admin yetkiniz bulunmamaktadır.', 'error');
      setTimeout(() => {
        window.location.href = '/admin/login.html';
      }, 1200);
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
      console.warn('[MasterAdmin apiFetch Warning]:', err.message);
    }
    throw err;
  }
}

function checkMasterAuth() {
  if (window.location.pathname.includes('login.html')) {
    return;
  }

  const token = localStorage.getItem('barons_admin_token');
  const rawUser = localStorage.getItem('barons_admin_user');

  if (!token || !rawUser) {
    window.location.href = '/master-admin/login.html';
    return;
  }

  try {
    const u = JSON.parse(rawUser);
    if (u.storeId !== 1 || (u.role !== 'OWNER' && u.role !== 'Super Admin')) {
      alert('⛔ Master Admin yetkiniz bulunmamaktadır.');
      window.location.href = '/admin/login.html';
    }
  } catch (e) {
    window.location.href = '/master-admin/login.html';
  }
}

function toggleMasterSidebar() {
  document.querySelector('.sidebar')?.classList.toggle('open');
}

function renderMasterUser() {
  const rawUser = localStorage.getItem('barons_admin_user');
  if (!rawUser) return;

  try {
    const user = JSON.parse(rawUser);
    const name = String(user.name || user.email || 'Platform Yöneticisi');
    const initials = name.split(/\s+|@/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'MA';
    const avatar = document.getElementById('masterUserAvatar');
    const nameElement = document.getElementById('masterUserName');
    const roleElement = document.getElementById('masterUserRole');

    if (avatar) avatar.textContent = initials;
    if (nameElement) nameElement.textContent = name;
    if (roleElement) roleElement.textContent = user.role === 'OWNER' ? 'Platform Yöneticisi' : user.role || 'Platform Yöneticisi';
  } catch (error) {
    // checkMasterAuth handles invalid session data and redirects to login.
  }
}

function logoutMasterAdmin() {
  localStorage.removeItem('barons_admin_token');
  localStorage.removeItem('barons_admin_user');
  showToast('👋 Master Admin oturumu kapatıldı.', 'info');
  setTimeout(() => {
    window.location.href = 'https://www.iscworks.info/';
  }, 600);
}

// ----------------------------------------------------
// PAGE LOADERS
// ----------------------------------------------------

// 1. Dashboard Loader
async function loadDashboardData() {
  try {
    const data = await apiFetch('/api/master-admin/dashboard');
    if (data && data.success) {
      const m = data.metrics || {};
      const elTotalMerchants = document.getElementById('metricTotalMerchants');
      const elActiveStores = document.getElementById('metricActiveStores');
      const elPendingApps = document.getElementById('metricPendingApps');
      const elSuspendedStores = document.getElementById('metricSuspendedStores');
      const elTotalUsers = document.getElementById('metricTotalUsers');
      const elTotalOrders = document.getElementById('metricTotalOrders');

      if (elTotalMerchants) elTotalMerchants.textContent = m.totalMerchants || 0;
      if (elActiveStores) elActiveStores.textContent = m.activeStores || 0;
      if (elPendingApps) elPendingApps.textContent = m.pendingApplications || 0;
      if (elSuspendedStores) elSuspendedStores.textContent = m.suspendedStores || 0;
      if (elTotalUsers) elTotalUsers.textContent = m.totalUsers || 0;
      if (elTotalOrders) elTotalOrders.textContent = m.totalOrders || 0;

      // Render Recent Applications Table
      const appsBody = document.getElementById('recentAppsTableBody');
      if (appsBody) {
        const apps = data.recentApplications || [];
        if (apps.length === 0) {
          appsBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 1rem; color: #94a3b8;">Bekleyen başvuru bulunmuyor.</td></tr>`;
        } else {
          appsBody.innerHTML = apps.map(a => `
            <tr>
              <td><strong>${escapeHtml(a.store_name)}</strong></td>
              <td>${escapeHtml(a.full_name)}</td>
              <td><span class="badge ${a.status}">${escapeHtml(a.status)}</span></td>
              <td>${escapeHtml(a.created_at)}</td>
              <td><a href="applications.html" class="btn btn-sm btn-outline">İncele</a></td>
            </tr>
          `).join('');
        }
      }

      // Render Recent Merchants Table
      const merchBody = document.getElementById('recentMerchantsTableBody');
      if (merchBody) {
        const merch = data.recentMerchants || [];
        if (merch.length === 0) {
          merchBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 1rem; color: #94a3b8;">Kayıtlı tüccar bulunmuyor.</td></tr>`;
        } else {
          merchBody.innerHTML = merch.map(m => `
            <tr>
              <td><strong>${escapeHtml(m.store_name)}</strong></td>
              <td>${escapeHtml(m.owner_name)}</td>
              <td>${escapeHtml(m.owner_email)}</td>
              <td><span class="badge ${m.store_status}">${escapeHtml(m.store_status)}</span></td>
              <td><a href="merchant.html?id=${m.store_id}" class="btn btn-sm btn-primary">Detay</a></td>
            </tr>
          `).join('');
        }
      }
    }
  } catch (e) {
    showToast('Gösterge paneli verileri yüklenemedi. Lütfen sayfayı yenileyin.', 'error');
  }
}

// 2. Merchants List Loader
async function loadMerchantsList() {
  const tableBody = document.getElementById('merchantsTableBody');
  if (!tableBody) return;

  const search = (document.getElementById('searchMerchantInput')?.value || '').trim();
  const status = document.getElementById('filterStatusSelect')?.value || 'all';

  try {
    const data = await apiFetch(`/api/master-admin/merchants?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`);
    if (data && data.success && Array.isArray(data.merchants)) {
      if (data.merchants.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 1.5rem; color: #94a3b8;">Filtrelere uygun tüccar bulunamadı.</td></tr>`;
        return;
      }
      tableBody.innerHTML = data.merchants.map(m => `
        <tr>
          <td>#${m.store_id}</td>
          <td><strong>${escapeHtml(m.store_name)}</strong><br><small style="color:#64748b;">${escapeHtml(m.store_slug)}</small></td>
          <td>${escapeHtml(m.owner_name || 'Bilinmiyor')}</td>
          <td>${escapeHtml(m.owner_email || '-')}<br><small style="color:#64748b;">${escapeHtml(m.owner_phone || '')}</small></td>
          <td><span class="code-tag">${escapeHtml(m.plan || 'Pro Store')}</span></td>
          <td><span class="badge ${m.store_status}">${escapeHtml(m.store_status)}</span></td>
          <td>${escapeHtml(m.store_created_at || '-')}</td>
          <td>
            <a href="merchant.html?id=${m.store_id}" class="btn btn-sm btn-outline"><i class="fa-solid fa-eye"></i> İncele</a>
            ${m.store_status === 'suspended' 
              ? `<button class="btn btn-sm btn-success" onclick="activateStoreAction(${m.store_id})"><i class="fa-solid fa-play"></i> Aktifleştir</button>`
              : `<button class="btn btn-sm btn-danger" onclick="suspendStoreAction(${m.store_id})"><i class="fa-solid fa-ban"></i> Askıya Al</button>`
            }
          </td>
        </tr>
      `).join('');
    }
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 1.5rem; color: #ef4444;">Tüccarlar yüklenirken hata oluştu. Lütfen tekrar deneyin.</td></tr>`;
    showToast('Tüccar listesi yüklenemedi. Lütfen tekrar deneyin.', 'error');
  }
}

// 3. Merchant Detail Loader
async function loadMerchantDetailData() {
  const urlParams = new URLSearchParams(window.location.search);
  const storeId = urlParams.get('id');
  if (!storeId) {
    alert('Geçersiz Mağaza ID!');
    window.location.href = 'merchants.html';
    return;
  }

  try {
    const data = await apiFetch(`/api/master-admin/merchants/${storeId}`);
    if (data && data.success && data.detail) {
      const d = data.detail;
      const s = d.store || {};
      const o = d.owner || {};
      const m = d.metrics || {};

      document.getElementById('detailStoreName').textContent = s.name || 'Mağaza Detayı';
      document.getElementById('detailStoreSlug').textContent = `Slug: ${s.slug || ''}`;
      document.getElementById('detailOwnerName').textContent = o.full_name || 'Bilinmiyor';
      document.getElementById('detailOwnerEmail').textContent = o.email || '-';
      document.getElementById('detailOwnerPhone').textContent = o.phone || '-';
      document.getElementById('detailPlan').textContent = d.application?.plan || 'Pro Store';
      document.getElementById('detailStatusBadge').className = `badge ${s.status}`;
      document.getElementById('detailStatusBadge').textContent = s.status;

      document.getElementById('metricProducts').textContent = m.productsCount || 0;
      document.getElementById('metricOrders').textContent = m.ordersCount || 0;
      document.getElementById('metricCustomers').textContent = m.customersCount || 0;
      document.getElementById('metricCampaigns').textContent = m.campaignsCount || 0;
      document.getElementById('metricAiUsage').textContent = m.aiUsageCount || 0;
      document.getElementById('metricApiKeys').textContent = m.apiKeysCount || 0;

      // Render Actions Buttons
      const actionsContainer = document.getElementById('detailActionsContainer');
      if (actionsContainer) {
        actionsContainer.innerHTML = `
          ${s.status === 'suspended'
            ? `<button class="btn btn-success" onclick="activateStoreAction(${s.id})"><i class="fa-solid fa-play"></i> Mağazayı Aktifleştir</button>`
            : `<button class="btn btn-danger" onclick="suspendStoreAction(${s.id})"><i class="fa-solid fa-ban"></i> Mağazayı Askıya Al</button>`
          }
          <button class="btn btn-outline" onclick="promptChangePlan(${s.id})"><i class="fa-solid fa-box-open"></i> Paket Değiştir</button>
        `;
      }

      // Render Recent Products
      const prodBody = document.getElementById('detailProductsBody');
      if (prodBody) {
        const prods = d.recentProducts || [];
        prodBody.innerHTML = prods.length === 0 
          ? `<tr><td colspan="4" style="text-align:center; color:#94a3b8;">Ürün bulunmuyor.</td></tr>`
          : prods.map(p => `<tr><td><strong>${escapeHtml(p.product_code)}</strong></td><td>${escapeHtml(p.name)}</td><td>${p.price} TL</td><td>${p.stock} Adet</td></tr>`).join('');
      }

      // Render Recent Orders
      const orderBody = document.getElementById('detailOrdersBody');
      if (orderBody) {
        const orders = d.recentOrders || [];
        orderBody.innerHTML = orders.length === 0
          ? `<tr><td colspan="4" style="text-align:center; color:#94a3b8;">Sipariş bulunmuyor.</td></tr>`
          : orders.map(o => `<tr><td>#${o.id}</td><td>${escapeHtml(o.customer_name)}</td><td>${o.total_price} TL</td><td>${o.status}</td></tr>`).join('');
      }

      // Render Audit Logs
      const auditBody = document.getElementById('detailAuditLogsBody');
      if (auditBody) {
        const logs = d.recentAuditLogs || [];
        auditBody.innerHTML = logs.length === 0
          ? `<tr><td colspan="4" style="text-align:center; color:#94a3b8;">Audit log bulunmuyor.</td></tr>`
          : logs.map(l => `<tr><td>#${l.id}</td><td><span class="badge active">${escapeHtml(l.action)}</span></td><td>${escapeHtml(l.entity_type)}</td><td>${escapeHtml(l.created_at)}</td></tr>`).join('');
      }
    }
  } catch (e) {
    showToast('Mağaza detayları yüklenemedi. Lütfen tekrar deneyin.', 'error');
  }
}

// 4. Applications Loader
async function loadMasterApplications() {
  const tableBody = document.getElementById('masterAppsTableBody');
  if (!tableBody) return;

  try {
    const data = await apiFetch('/api/master-admin/applications');
    if (data && data.success && Array.isArray(data.applications)) {
      if (data.applications.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #94a3b8;">Başvuru kaydı bulunmamaktadır.</td></tr>`;
        return;
      }
      tableBody.innerHTML = data.applications.map(a => `
        <tr>
          <td>#${a.id}</td>
          <td><strong>${escapeHtml(a.store_name)}</strong></td>
          <td>${escapeHtml(a.full_name)}</td>
          <td>${escapeHtml(a.email)}</td>
          <td><span class="code-tag">${escapeHtml(a.plan || 'Pro Store')}</span></td>
          <td><span class="badge ${a.status}">${escapeHtml(a.status)}</span></td>
          <td>
            ${a.status === 'pending'
              ? `<button class="btn btn-sm btn-success" onclick="approveAppAction(${a.id})"><i class="fa-solid fa-check"></i> Onayla</button>
                 <button class="btn btn-sm btn-danger" onclick="rejectAppAction(${a.id})"><i class="fa-solid fa-xmark"></i> Reddet</button>`
              : `<span style="font-size:11px; color:#64748b;">İşlem Tamamlandı</span>`
            }
          </td>
        </tr>
      `).join('');
    }
  } catch (e) {
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #ef4444;">Başvurular alınamadı. Lütfen tekrar deneyin.</td></tr>`;
    showToast('Başvurular yüklenemedi. Lütfen tekrar deneyin.', 'error');
  }
}

// ----------------------------------------------------
// ACTIONS
// ----------------------------------------------------
async function approveAppAction(id) {
  if (!confirm('Bu mağaza başvurusunu onaylamak istiyor musunuz?')) return;
  try {
    const data = await apiFetch(`/api/master-admin/applications/${id}/approve`, { method: 'POST' });
    showToast(data.message || 'Başvuru onaylandı.', 'success');
    if (window.location.pathname.includes('applications.html')) loadMasterApplications();
    else loadDashboardData();
  } catch (e) {
    showToast(e.message || 'Başvuru onaylanamadı. Lütfen tekrar deneyin.', 'error');
  }
}

async function rejectAppAction(id) {
  if (!confirm('Bu mağaza başvurusunu reddetmek istiyor musunuz?')) return;
  try {
    const data = await apiFetch(`/api/master-admin/applications/${id}/reject`, { method: 'POST' });
    showToast(data.message || 'Başvuru reddedildi.', 'info');
    if (window.location.pathname.includes('applications.html')) loadMasterApplications();
    else loadDashboardData();
  } catch (e) {
    showToast(e.message || 'Başvuru reddedilemedi. Lütfen tekrar deneyin.', 'error');
  }
}

async function suspendStoreAction(storeId) {
  if (!confirm('Bu mağazayı askıya almak istediğinizden emin misiniz? Mağaza erişimi engellenecektir.')) return;
  try {
    const data = await apiFetch(`/api/master-admin/stores/${storeId}/suspend`, { method: 'POST' });
    showToast(data.message || 'Mağaza askıya alındı.', 'warning');
    if (window.location.pathname.includes('merchants.html')) loadMerchantsList();
    if (window.location.pathname.includes('merchant.html')) loadMerchantDetailData();
  } catch (e) {
    showToast(e.message || 'Mağaza askıya alınamadı. Lütfen tekrar deneyin.', 'error');
  }
}

async function activateStoreAction(storeId) {
  if (!confirm('Bu mağazayı yeniden aktifleştirmek istiyor musunuz?')) return;
  try {
    const data = await apiFetch(`/api/master-admin/stores/${storeId}/activate`, { method: 'POST' });
    showToast(data.message || 'Mağaza aktifleştirildi!', 'success');
    if (window.location.pathname.includes('merchants.html')) loadMerchantsList();
    if (window.location.pathname.includes('merchant.html')) loadMerchantDetailData();
  } catch (e) {
    showToast(e.message || 'Mağaza aktifleştirilemedi. Lütfen tekrar deneyin.', 'error');
  }
}

async function promptChangePlan(storeId) {
  const choices = ['Starter Store', 'Pro Store', 'Enterprise Store'];
  const selection = prompt('Paket seçin:\n1 - Starter Store\n2 - Pro Store\n3 - Enterprise Store', '2');
  if (selection === null) return;
  const newPlan = choices[Number(selection) - 1];
  if (!newPlan) {
    showToast('Geçerli bir paket seçin.', 'warning');
    return;
  }
  try {
    const data = await apiFetch(`/api/master-admin/stores/${storeId}/change-plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: newPlan })
    });
    showToast(data.message || 'Paket güncellendi.', 'success');
    if (window.location.pathname.includes('merchant.html')) loadMerchantDetailData();
  } catch (e) {
    showToast(e.message || 'Paket güncellenemedi. Lütfen tekrar deneyin.', 'error');
  }
}

// Global App Init
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sidebar-menu a').forEach(link => {
    link.addEventListener('click', () => document.querySelector('.sidebar')?.classList.remove('open'));
  });
  setupMasterThemeToggle();
  checkMasterAuth();
  renderMasterUser();

  const path = window.location.pathname;
  if (path.includes('index.html') || path.endsWith('/master-admin') || path.endsWith('/master-admin/')) {
    loadDashboardData();
  } else if (path.includes('merchants.html')) {
    loadMerchantsList();
    document.getElementById('searchMerchantInput')?.addEventListener('input', () => loadMerchantsList());
    document.getElementById('filterStatusSelect')?.addEventListener('change', () => loadMerchantsList());
  } else if (path.includes('merchant.html')) {
    loadMerchantDetailData();
  } else if (path.includes('applications.html')) {
    loadMasterApplications();
  }
});
