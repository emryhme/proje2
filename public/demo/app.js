const initialProducts = [
  { short:'HBL', code:'HBL-S', name:'Havana Blazer', color:'Siyah', size:'S', price:1299, stock:18, category:'Ceket' },
  { short:'HBL', code:'HBL-M', name:'Havana Blazer', color:'Siyah', size:'M', price:1299, stock:24, category:'Ceket' },
  { short:'HBL', code:'HBL-L', name:'Havana Blazer', color:'Siyah', size:'L', price:1299, stock:9, category:'Ceket' },
  { short:'GMA', code:'GMA-S', name:'Grand Modal Elbise', color:'Bordo', size:'S', price:899, stock:31, category:'Elbise' },
  { short:'GMA', code:'GMA-M', name:'Grand Modal Elbise', color:'Bordo', size:'M', price:899, stock:16, category:'Elbise' },
  { short:'SKG', code:'SKG-M', name:'Siyah Keten Gömlek', color:'Siyah', size:'M', price:649, stock:42, category:'Gömlek' }
];
const initialOrders = [
  { id:'DM-1048', customer:'Demo Müşteri 01', product:'HBL-M · 1 adet', date:'Bugün, 14:32', total:1348, status:'Bekliyor' },
  { id:'DM-1047', customer:'Demo Müşteri 02', product:'GMA-S · 2 adet', date:'Bugün, 13:18', total:1847, status:'Onaylandı' },
  { id:'DM-1046', customer:'Demo Müşteri 03', product:'SKG-M · 1 adet', date:'Bugün, 12:05', total:698, status:'Kargoda' },
  { id:'DM-1045', customer:'Demo Müşteri 04', product:'HBL-S · 1 adet', date:'Dün, 22:41', total:1348, status:'Onaylandı' },
  { id:'DM-1044', customer:'Demo Müşteri 05', product:'GMA-M · 1 adet', date:'Dün, 20:16', total:948, status:'Reddedildi' },
  { id:'DM-1043', customer:'Demo Müşteri 06', product:'HBL-L · 2 adet', date:'Dün, 18:30', total:2647, status:'Kargoda' },
  { id:'DM-1042', customer:'Demo Müşteri 07', product:'SKG-M · 2 adet', date:'Dün, 16:12', total:1347, status:'Onaylandı' },
  { id:'DM-1041', customer:'Demo Müşteri 08', product:'GMA-S · 1 adet', date:'Dün, 14:55', total:948, status:'Bekliyor' }
];
const initialCampaigns = [
  { title:'Yaz Sezonu', detail:'Sepette ikinci ürüne otomatik %20 indirim uygular.', code:'YAZ20', icon:'sun', active:true },
  { title:'Ücretsiz Kargo', detail:'1.500 TL ve üzerindeki demo sepetlere ücretsiz kargo.', code:'KARGO0', icon:'truck', active:true },
  { title:'VIP Müşteri', detail:'Örnek VIP müşterilere özel %15 sadakat indirimi.', code:'VIP15', icon:'crown', active:false }
];

let products = structuredClone(initialProducts);
let orders = structuredClone(initialOrders);
let campaigns = structuredClone(initialCampaigns);
let chatHistory = [];
let chart;

const money = value => Number(value).toLocaleString('tr-TR', { style:'currency', currency:'TRY', maximumFractionDigits:0 });
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function showPage(name) {
  document.querySelectorAll('.demo-page').forEach(page => page.classList.toggle('active', page.id === `page-${name}`));
  document.querySelectorAll('.nav-item[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === name));
  document.getElementById('sidebar').classList.remove('open');
  window.scrollTo({ top:0, behavior:'smooth' });
  if (name === 'dashboard' && chart) chart.resize();
  lucide.createIcons();
}

function toast(message) {
  const host = document.getElementById('toastContainer');
  host.innerHTML = `<div class="demo-toast">${escapeHtml(message)}</div>`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { host.innerHTML = ''; }, 2800);
}

function renderChart() {
  chart?.destroy();
  chart = new Chart(document.getElementById('revenueTrendChart'), {
    type:'line',
    data:{ labels:['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'], datasets:[{ label:'Demo Ciro', data:[2480,3190,2860,4120,3540,4890,3600], borderColor:'#a3ff12', backgroundColor:'rgba(163,255,18,.08)', fill:true, tension:.4, pointRadius:3, pointBackgroundColor:'#a3ff12' }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ grid:{ display:false }, ticks:{ color:'#8a8f9e' } }, y:{ grid:{ color:'rgba(255,255,255,.06)' }, ticks:{ color:'#8a8f9e', callback:v => `₺${v}` } } } }
  });
}

function renderTopProducts() {
  const data = [
    ['Havana Blazer','HBL · 51 satış',84], ['Grand Modal Elbise','GMA · 38 satış',65],
    ['Siyah Keten Gömlek','SKG · 22 satış',46], ['Yazlık Keten Mont','YKM · 12 satış',30]
  ];
  document.getElementById('topProductsList').innerHTML = data.map((item, i) => `<div class="channel"><div class="channel-icon"><i data-lucide="${i ? 'package' : 'flame'}"></i></div><div class="channel-info"><strong>${item[0]}</strong><span>${item[1]}</span><div class="progress"><div style="width:${item[2]}%"></div></div></div><div class="channel-price">${item[2]}%</div></div>`).join('');
}

function renderProducts() {
  const query = document.getElementById('globalSearch').value.trim().toLocaleLowerCase('tr-TR');
  const visible = products.filter(p => `${p.short} ${p.code} ${p.name}`.toLocaleLowerCase('tr-TR').includes(query));
  document.getElementById('productsTableBody').innerHTML = visible.map(p => `<tr><td><span class="code-tag">${escapeHtml(p.short)}</span></td><td><span class="code-tag">${escapeHtml(p.code)}</span></td><td><strong>${escapeHtml(p.name)}</strong></td><td>${escapeHtml(p.color)}</td><td><span class="size-pill">${escapeHtml(p.size)}</span></td><td><div class="stock-editor"><button data-stock="${p.code}" data-delta="-1">−</button><strong>${p.stock}</strong><button data-stock="${p.code}" data-delta="1">+</button></div></td><td><input class="price-input" type="number" min="1" value="${p.price}" data-price="${p.code}"></td><td>${escapeHtml(p.category)}</td><td><button class="btn btn-secondary btn-sm" data-detail="${p.code}">Detay</button></td></tr>`).join('');
  document.getElementById('productsTableCount').textContent = `${visible.length} demo ürün listelendi`;
  document.getElementById('statProducts').textContent = products.length;
  document.getElementById('statStock').textContent = products.reduce((sum, p) => sum + p.stock, 0);
  lucide.createIcons();
}

function statusClass(status) {
  if (status === 'Onaylandı' || status === 'Kargoda') return 'status-success';
  if (status === 'Reddedildi') return 'status-danger';
  return 'status-warning';
}

function renderOrders() {
  document.getElementById('ordersTable').innerHTML = orders.map(o => `<tr><td><span class="order-id-tag">${o.id}</span></td><td><strong>${o.customer}</strong></td><td>${o.product}</td><td>${o.date}</td><td><strong>${money(o.total)}</strong></td><td><span class="status ${statusClass(o.status)}">${o.status}</span></td><td><button class="btn btn-secondary btn-sm" data-order="${o.id}">Durumu Değiştir</button></td></tr>`).join('');
}

function renderCampaigns() {
  document.getElementById('campaignGrid').innerHTML = campaigns.map((c, index) => `<article class="card campaign-card"><div class="campaign-card-head"><div class="campaign-icon"><i data-lucide="${c.icon}"></i></div><span class="status ${c.active ? 'status-success' : 'status-danger'}">${c.active ? 'AKTİF' : 'KAPALI'}</span></div><h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.detail)}</p><span class="campaign-code">${escapeHtml(c.code)}</span><div class="campaign-foot"><span class="muted">Demo kampanya</span><button class="demo-toggle ${c.active ? 'on' : ''}" data-campaign="${index}" aria-label="Kampanyayı aç veya kapat"></button></div></article>`).join('');
  lucide.createIcons();
}

function appendMessage(role, text, id='') {
  const message = document.createElement('div');
  message.className = `ai-message ${role}`;
  if (id) message.id = id;
  message.innerHTML = role === 'user' ? `<div class="ai-bubble">${escapeHtml(text)}</div>` : `<div class="ai-avatar"><i class="fa-solid fa-robot"></i></div><div class="ai-bubble">${escapeHtml(text)}</div>`;
  const windowEl = document.getElementById('aiAdminChatWindow');
  windowEl.appendChild(message);
  windowEl.scrollTop = windowEl.scrollHeight;
}

async function sendChat(text) {
  const clean = text.trim();
  if (!clean) return;
  appendMessage('user', clean);
  const history = chatHistory.slice(-8);
  chatHistory.push({ role:'user', text:clean });
  appendMessage('assistant', 'Demo verileri inceleniyor…', 'typingMessage');
  const submit = document.querySelector('#chatForm button');
  submit.disabled = true;
  try {
    const response = await fetch('/api/demo/ai', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ message:clean, history }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || 'Demo yanıtı alınamadı.');
    document.getElementById('typingMessage')?.remove();
    appendMessage('assistant', data.reply);
    chatHistory.push({ role:'model', text:data.reply });
  } catch (error) {
    document.getElementById('typingMessage')?.remove();
    appendMessage('assistant', `Üzgünüm, ${error.message || 'Gemini bağlantısı kurulamadı.'}`);
  } finally { submit.disabled = false; }
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) showPage(pageButton.dataset.page);
  const stockButton = event.target.closest('[data-stock]');
  if (stockButton) {
    const product = products.find(p => p.code === stockButton.dataset.stock);
    product.stock = Math.max(0, product.stock + Number(stockButton.dataset.delta));
    renderProducts(); toast(`${product.code} stoğu yalnızca demoda güncellendi.`);
  }
  const detailButton = event.target.closest('[data-detail]');
  if (detailButton) toast(`${detailButton.dataset.detail} demo ürün detayı açıldı.`);
  const orderButton = event.target.closest('[data-order]');
  if (orderButton) {
    const steps = ['Bekliyor','Onaylandı','Kargoda'];
    const order = orders.find(o => o.id === orderButton.dataset.order);
    order.status = steps[(Math.max(0, steps.indexOf(order.status)) + 1) % steps.length];
    renderOrders(); toast(`${order.id} durumu yalnızca demoda güncellendi.`);
  }
  const campaignButton = event.target.closest('[data-campaign]');
  if (campaignButton) { const campaign = campaigns[Number(campaignButton.dataset.campaign)]; campaign.active = !campaign.active; renderCampaigns(); toast('Kampanya durumu yalnızca demoda değişti.'); }
  const prompt = event.target.closest('[data-prompt]');
  if (prompt) { showPage('ai'); sendChat(prompt.dataset.prompt); }
});

document.getElementById('mobileMenu').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('globalSearch').addEventListener('input', () => { showPage('dashboard'); renderProducts(); });
document.getElementById('saveDemoStock').addEventListener('click', () => toast('Demo değişiklikleri bu sekmede tutuldu; veritabanına yazılmadı.'));
document.getElementById('productsTableBody').addEventListener('change', event => { if (event.target.dataset.price) { const product = products.find(p => p.code === event.target.dataset.price); product.price = Math.max(1, Number(event.target.value)); toast(`${product.code} fiyatı yalnızca demoda güncellendi.`); } });
document.getElementById('newCampaign').addEventListener('click', () => { if (!campaigns.some(c => c.code === 'DEMO10')) campaigns.push({ title:'Hafta Sonu Demo', detail:'Tüm demo ürünlerinde geçici %10 indirim.', code:'DEMO10', icon:'wand-sparkles', active:true }); renderCampaigns(); toast('Yeni demo kampanya oluşturuldu.'); });
document.getElementById('productForm').addEventListener('submit', event => { event.preventDefault(); const short = document.getElementById('newShortCode').value.trim().toUpperCase(); const size = document.getElementById('newSize').value; const code = `${short}-${size}`; if (products.some(p => p.code === code)) return toast(`${code} demo listesinde zaten var.`); products.push({ short, code, name:document.getElementById('newName').value.trim(), color:'Demo', size, price:Number(document.getElementById('newPrice').value), stock:Number(document.getElementById('newStock').value), category:'Demo' }); renderProducts(); showPage('dashboard'); toast(`${code} yalnızca demo envanterine eklendi.`); });
document.querySelectorAll('#settingsForm,#personaForm').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); toast('Ayar yalnızca demo ekranında kaydedildi.'); }));
document.getElementById('resetDemo').addEventListener('click', () => { products = structuredClone(initialProducts); orders = structuredClone(initialOrders); campaigns = structuredClone(initialCampaigns); renderProducts(); renderOrders(); renderCampaigns(); toast('Demo verileri başlangıç durumuna döndü.'); });
document.getElementById('chatForm').addEventListener('submit', event => { event.preventDefault(); const input = document.getElementById('chatInput'); const text = input.value; input.value = ''; sendChat(text); });
document.getElementById('chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.getElementById('chatForm').requestSubmit(); } });

renderChart(); renderTopProducts(); renderProducts(); renderOrders(); renderCampaigns(); lucide.createIcons();
