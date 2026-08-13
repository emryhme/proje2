const initialProducts = [
  { code:'HBL-S', name:'Havana Blazer', size:'S', price:1299, stock:18 },
  { code:'HBL-M', name:'Havana Blazer', size:'M', price:1299, stock:24 },
  { code:'HBL-L', name:'Havana Blazer', size:'L', price:1299, stock:9 },
  { code:'GMA-S', name:'Grand Modal Elbise', size:'S', price:899, stock:31 },
  { code:'GMA-M', name:'Grand Modal Elbise', size:'M', price:899, stock:16 },
  { code:'SKG-M', name:'Siyah Keten Gömlek', size:'M', price:649, stock:42 }
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
  { title:'Yaz Sezonu', detail:'Sepette ikinci ürüne otomatik %20 indirim uygular.', code:'YAZ20', icon:'fa-sun', active:true },
  { title:'Ücretsiz Kargo', detail:'1.500 TL ve üzerindeki demo sepetlere ücretsiz kargo.', code:'KARGO0', icon:'fa-truck-fast', active:true },
  { title:'VIP Müşteri', detail:'Örnek VIP müşterilere özel %15 sadakat indirimi.', code:'VIP15', icon:'fa-crown', active:false }
];

let products = structuredClone(initialProducts);
let orders = structuredClone(initialOrders);
let campaigns = structuredClone(initialCampaigns);
let chatHistory = [];

const pageMeta = {
  dashboard:['Dashboard','Sabit ve yapay verilerle hazırlanmış mağaza özeti'],
  stocks:['Stoklar','Tarayıcıda çalışan güvenli demo stok yönetimi'],
  orders:['Siparişler','Kurgusal müşteri ve sipariş kayıtları'],
  campaigns:['Kampanyalar','Kalıcı olmayan örnek kampanya yönetimi'],
  ai:['Gemini AI Demo','Gerçek Gemini, yalnızca yapay demo verileri']
};

const money = value => `₺${Number(value).toLocaleString('tr-TR')}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const statusClass = status => ({'Bekliyor':'waiting','Onaylandı':'approved','Kargoda':'shipped','Reddedildi':'rejected'}[status] || 'waiting');

function goToPage(pageName){
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === `page-${pageName}`));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === pageName));
  document.getElementById('pageTitle').textContent = pageMeta[pageName][0];
  document.getElementById('pageSubtitle').textContent = pageMeta[pageName][1];
  document.getElementById('sidebar').classList.remove('open');
}

function renderChart(){
  const values = [42,58,51,75,63,91,79];
  document.getElementById('salesChart').innerHTML = values.map((height,index) => `<i class="bar" style="height:${height}%" data-value="${money([2480,3190,2860,4120,3540,4890,3600][index])}"></i>`).join('');
}

function renderActivity(){
  const activities = [
    ['fa-bag-shopping','Yeni demo sipariş','DM-1048 · HBL-M'],
    ['fa-comment','Instagram yorumu','“Fiyat bilgisi alabilir miyim?”'],
    ['fa-box','Stok hareketi','GMA-S · 2 adet ayrıldı'],
    ['fa-sparkles','Gemini analizi','Satış özeti hazırlandı']
  ];
  document.getElementById('activityFeed').innerHTML = activities.map(item => `<div class="activity"><div class="activity-icon"><i class="fa-solid ${item[0]}"></i></div><div><strong>${item[1]}</strong><span>${item[2]}</span></div></div>`).join('');
}

function orderRow(order, full=false){
  return `<tr><td><span class="code">${escapeHtml(order.id)}</span></td><td><strong>${escapeHtml(order.customer)}</strong></td><td>${escapeHtml(order.product)}</td>${full?`<td>${escapeHtml(order.date)}</td>`:''}<td><strong>${money(order.total)}</strong></td><td><span class="status-badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td>${full?`<td><button class="row-btn" onclick="cycleOrder('${order.id}')">Durumu değiştir</button></td>`:''}</tr>`;
}

function renderOrders(){
  document.getElementById('dashboardOrders').innerHTML = orders.slice(0,4).map(order => orderRow(order)).join('');
  document.getElementById('ordersTable').innerHTML = orders.map(order => orderRow(order,true)).join('');
}

function renderStocks(){
  const query = document.getElementById('stockSearch')?.value.toLocaleLowerCase('tr-TR') || '';
  const filtered = products.filter(product => `${product.code} ${product.name}`.toLocaleLowerCase('tr-TR').includes(query));
  document.getElementById('stockTable').innerHTML = filtered.map(product => `<tr><td><span class="code">${product.code}</span></td><td><strong>${product.name}</strong></td><td>${product.size}</td><td>${money(product.price)}</td><td><div class="stock-control"><button onclick="changeStock('${product.code}',-1)">−</button><span class="stock-number">${product.stock}</span><button onclick="changeStock('${product.code}',1)">+</button></div></td><td><button class="row-btn" onclick="demoToast('${product.code} değişikliği yalnızca demoda tutuldu.')">Demo Detay</button></td></tr>`).join('');
  const total = products.reduce((sum,item)=>sum+item.stock,0);
  document.getElementById('stockSummary').textContent = `${products.length} varyant · ${total} adet toplam stok`;
  document.getElementById('dashboardStock').textContent = total;
  document.getElementById('stockNavCount').textContent = products.length;
}

function renderCampaigns(){
  document.getElementById('campaignGrid').innerHTML = campaigns.map((campaign,index) => `<article class="campaign"><div class="campaign-icon"><i class="fa-solid ${campaign.icon}"></i></div><h3>${escapeHtml(campaign.title)}</h3><p>${escapeHtml(campaign.detail)}</p><span class="campaign-code">${escapeHtml(campaign.code)}</span><div class="campaign-foot"><span class="status-badge ${campaign.active?'approved':'rejected'}">${campaign.active?'AKTİF':'KAPALI'}</span><button class="toggle ${campaign.active?'on':''}" onclick="toggleCampaign(${index})" aria-label="Kampanyayı aç veya kapat"><i></i></button></div></article>`).join('');
}

window.changeStock = (code,amount) => {
  const product = products.find(item => item.code === code);
  if (!product) return;
  product.stock = Math.max(0,product.stock+amount);
  renderStocks();
  demoToast(`${code} demo stoğu ${product.stock} olarak değişti.`);
};
window.cycleOrder = id => {
  const steps=['Bekliyor','Onaylandı','Kargoda'];
  const order=orders.find(item=>item.id===id);
  if(!order)return;
  order.status=steps[(Math.max(0,steps.indexOf(order.status))+1)%steps.length];
  renderOrders();
  demoToast(`${id} durumu yalnızca demoda güncellendi.`);
};
window.toggleCampaign = index => {
  campaigns[index].active=!campaigns[index].active;
  renderCampaigns();
  demoToast(`Kampanya ${campaigns[index].active?'açıldı':'kapatıldı'} · kalıcı değildir.`);
};

let toastTimer;
window.demoToast = message => {
  const toast=document.getElementById('toast');
  toast.textContent=message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.classList.remove('show'),2600);
};

function appendMessage(role,text,id=''){
  const container=document.getElementById('chatMessages');
  const element=document.createElement('div');
  element.className=`message ${role}`;
  if(id) element.id=id;
  if(role==='user') element.innerHTML=`<div>${escapeHtml(text)}</div>`;
  else element.innerHTML=`<div class="msg-avatar"><i class="fa-solid fa-sparkles"></i></div><div>${escapeHtml(text)}</div>`;
  container.appendChild(element);
  container.scrollTop=container.scrollHeight;
}

async function sendChat(text){
  const clean=text.trim();
  if(!clean)return;
  appendMessage('user',clean);
  const historyForRequest=chatHistory.slice(-8);
  chatHistory.push({role:'user',text:clean});
  appendMessage('assistant','Gemini demo verilerini inceliyor…','typingMessage');
  const submit=document.querySelector('#chatForm button');
  submit.disabled=true;
  try{
    const response=await fetch('/api/demo/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:clean,history:historyForRequest})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.success)throw new Error(data.error||'Demo yanıtı alınamadı.');
    document.getElementById('typingMessage')?.remove();
    appendMessage('assistant',data.reply);
    chatHistory.push({role:'model',text:data.reply});
  }catch(error){
    document.getElementById('typingMessage')?.remove();
    appendMessage('assistant',`Üzgünüm, ${error.message||'Gemini bağlantısı kurulamadı.'}`);
  }finally{submit.disabled=false;}
}

document.querySelectorAll('[data-page]').forEach(item=>item.addEventListener('click',()=>goToPage(item.dataset.page)));
document.querySelectorAll('[data-go]').forEach(item=>item.addEventListener('click',()=>goToPage(item.dataset.go)));
document.getElementById('mobileMenu').addEventListener('click',()=>document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('stockSearch').addEventListener('input',renderStocks);
document.getElementById('addDemoProduct').addEventListener('click',()=>{
  if(products.some(item=>item.code==='YKM-M'))return demoToast('YKM-M demo ürünü zaten eklendi.');
  products.push({code:'YKM-M',name:'Yazlık Keten Mont',size:'M',price:1099,stock:12});renderStocks();demoToast('YKM-M yalnızca demo listesine eklendi.');
});
document.getElementById('newCampaign').addEventListener('click',()=>{
  if(campaigns.some(item=>item.code==='DEMO10'))return demoToast('Demo kampanya zaten oluşturuldu.');
  campaigns.push({title:'Hafta Sonu Demo',detail:'Tüm demo ürünlerinde geçici %10 indirim.',code:'DEMO10',icon:'fa-wand-magic-sparkles',active:true});renderCampaigns();demoToast('Kalıcı olmayan demo kampanya oluşturuldu.');
});
document.getElementById('resetDemo').addEventListener('click',()=>{products=structuredClone(initialProducts);orders=structuredClone(initialOrders);campaigns=structuredClone(initialCampaigns);renderAll();demoToast('Demo verileri başlangıç durumuna döndü.');});
document.getElementById('chatForm').addEventListener('submit',event=>{event.preventDefault();const input=document.getElementById('chatInput');const text=input.value;input.value='';sendChat(text);});
document.getElementById('chatInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();document.getElementById('chatForm').requestSubmit();}});
document.querySelectorAll('[data-prompt]').forEach(button=>button.addEventListener('click',()=>{goToPage('ai');sendChat(button.dataset.prompt);}));
document.getElementById('clearChat').addEventListener('click',()=>{chatHistory=[];document.getElementById('chatMessages').innerHTML='';appendMessage('assistant','Sohbet temizlendi. Demo mağaza hakkında yeni bir soru sorabilirsiniz.');});

function renderAll(){renderChart();renderActivity();renderOrders();renderStocks();renderCampaigns();}
renderAll();
