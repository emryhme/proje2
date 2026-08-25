(() => {
  const STORAGE_KEY = 'iscworks_cookie_consent_v1';
  const banner = document.createElement('section');
  banner.className = 'cookie-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Çerez tercihleri');
  banner.innerHTML = `<div><strong>Çerez tercihlerinizi önemsiyoruz</strong><p>Site işlevleri için gerekli teknolojileri kullanıyoruz. İsteğe bağlı kullanım ölçümü yalnızca onayınızla etkinleştirilir. <a href="/cerez-politikasi">Ayrıntıları okuyun</a>.</p></div><div class="cookie-actions"><button type="button" class="btn btn-secondary" data-cookie-details>Ayarlar</button><button type="button" class="btn btn-secondary" data-cookie-reject>Yalnızca gerekli</button><button type="button" class="btn btn-primary" data-cookie-accept>Tümünü kabul et</button></div><div class="cookie-details" hidden><strong>Gerekli depolama: Her zaman açık</strong><p>Oturum güvenliği ve tercih kaydı için gereklidir. Analitik depolama şu anda kullanılmamaktadır; ileride eklenirse onay verilmeden yüklenmeyecektir.</p></div>`;
  document.body.appendChild(banner);

  const save = (choice) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice, updatedAt: new Date().toISOString() }));
    banner.hidden = true;
    window.dispatchEvent(new CustomEvent('iscworks:cookie-consent', { detail: { choice } }));
  };
  banner.querySelector('[data-cookie-accept]').addEventListener('click', () => save('all'));
  banner.querySelector('[data-cookie-reject]').addEventListener('click', () => save('necessary'));
  banner.querySelector('[data-cookie-details]').addEventListener('click', () => {
    const details = banner.querySelector('.cookie-details');
    details.hidden = !details.hidden;
  });
  document.querySelectorAll('[data-cookie-settings]').forEach((button) => button.addEventListener('click', () => {
    banner.hidden = false;
    banner.querySelector('.cookie-details').hidden = false;
    banner.querySelector('[data-cookie-reject]').focus();
  }));
  banner.hidden = Boolean(localStorage.getItem(STORAGE_KEY));
})();
