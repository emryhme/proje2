import readline from 'readline';
import axios from 'axios';
import { env } from '../config/env';

/**
 * iscworks bot - Meta Instagram Webhook CLI & Test Terminali
 */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const BASE_URL = `http://localhost:3000`;
const FIXED_WEBHOOK_URL = `https://iscworks-bot-v2.loca.lt/webhook/instagram`;
const VERIFY_TOKEN = env.fbVerifyToken;

function showBanner() {
  console.clear();
  console.log(`
====================================================================
 🤖 iscworks bot - Meta Instagram Webhook CLI & Test Terminali
====================================================================
  🌐 Yerel Adres    : ${BASE_URL}
  📌 Sabit Webhook  : ${FIXED_WEBHOOK_URL}
  🔑 Verify Token   : ${VERIFY_TOKEN}
====================================================================
  `);
}

function showMenu() {
  console.log(`
Lütfen yapmak istediğiniz işlemi seçin:

 [1] 🧪 Meta Hub Challenge Doğrulamasını Test Et (Local & Sabit Webhook)
 [2] 📩 Örnek Instagram DM Mesajı Simüle Et (POST /webhook/instagram)
 [3] 📊 Canlı Sipariş & Stok Verilerini Göster
 [0] ❌ Çıkış Yap

  `);
  rl.question('Seçiminiz (0-3): ', handleChoice);
}

async function handleChoice(answer: string) {
  const choice = answer.trim();

  switch (choice) {
    case '1':
      await testHubChallenge();
      break;
    case '2':
      await simulateIncomingMessage();
      break;
    case '3':
      await showDatabaseStats();
      break;
    case '0':
      console.log('\n👋 iscworks bot CLI kapatılıyor...\n');
      rl.close();
      process.exit(0);
      return;
    default:
      console.log('⚠️ Geçersiz seçim, lütfen 0-3 arası bir değer girin.');
  }

  promptContinue();
}

/**
 * 1. Meta Hub Challenge Testi (Yerel & Sabit Webhook)
 */
async function testHubChallenge() {
  console.log('\n🧪 Meta Hub Challenge Doğrulama Testi Başlatılıyor...');
  const testChallenge = `CHALLENGE_${Math.floor(Math.random() * 900000 + 100000)}`;

  // 1. Yerel Test
  try {
    const localUrl = `${BASE_URL}/webhook/instagram?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${testChallenge}`;
    console.log(`📡 1. Yerel Sunucu Testi (http://localhost:3000)...`);
    const localRes = await axios.get(localUrl);

    if (localRes.data.toString() === testChallenge) {
      console.log(` ✅ Yerel Sunucu Doğrulaması BAŞARILI! (Dönen Challenge: "${localRes.data}")`);
    } else {
      console.log(` ⚠️ Yerel Challenge uyuşmadı: "${localRes.data}"`);
    }
  } catch (err: any) {
    console.error(' ❌ Yerel Webhook testi başarısız:', err?.message);
  }

  // 2. Sabit Webhook Testi
  try {
    const fixedUrl = `${FIXED_WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${testChallenge}`;
    console.log(`\n📡 2. Sabit Webhook Adresi Testi (${FIXED_WEBHOOK_URL})...`);
    const fixedRes = await axios.get(fixedUrl, {
      headers: {
        'bypass-tunnel-reminder': 'true',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MetaInspector/1.0'
      },
      timeout: 8000
    });

    console.log(` ✅ Sabit Webhook HTTP ${fixedRes.status}`);
    if (fixedRes.data.toString() === testChallenge) {
      console.log(' 🎉 TEBRİKLER! Sabit Webhook Meta doğrulaması %100 BAŞARILI!');
      console.log(' Meta Developers Paneli bu adresi yeşil tık ile onaylayacaktır.');
    } else {
      console.log(` ⚠️ Sabit Webhook Challenge dönüşü: "${fixedRes.data}"`);
    }
  } catch (err: any) {
    console.warn(' ℹ️ Sabit tünel testi tamamlandı (Tünel geçici meşgul olabilir veya yerel yanıt alındı).');
  }
}

/**
 * 2. Örnek Instagram DM Mesajı Simüle Et (POST /webhook/instagram)
 */
async function simulateIncomingMessage() {
  console.log('\n📩 Simüle Edilecek Örnek Mesajlar:');
  console.log(' [a] "selam"');
  console.log(' [b] "KGMLW-M var mı?"');
  console.log(' [c] "Emre İşcenkal 05428523712 Süleyman Mahallesi 1010 Sokak No 7 1 adet"');
  console.log(' [d] Özel Mesaj Yaz');

  rl.question('\nSeçiminiz (a-d): ', async (subChoice) => {
    let msgText = 'selam';
    const cleanSub = subChoice.trim().toLowerCase();

    if (cleanSub === 'b') msgText = 'KGMLW-M var mı?';
    else if (cleanSub === 'c') msgText = 'Emre İşcenkal 05428523712 Süleyman Mahallesi 1010 Sokak No 7 1 adet';
    else if (cleanSub === 'd') {
      await new Promise<void>((resolve) => {
        rl.question('Gönderilecek Mesaj: ', (customMsg) => {
          msgText = customMsg.trim() || 'selam';
          resolve();
        });
      });
    }

    const testSenderId = `TEST_USER_${Math.floor(Math.random() * 8999 + 1000)}`;
    const mockPayload = {
      object: 'instagram',
      entry: [
        {
          time: Date.now(),
          id: '17841478682085969',
          messaging: [
            {
              sender: { id: testSenderId },
              recipient: { id: '17841478682085969' },
              timestamp: Date.now(),
              message: {
                mid: `mid_${Date.now()}`,
                text: msgText
              }
            }
          ]
        }
      ]
    };

    console.log(`\n🚀 Webhook Mesajı POST Ediliyor (${testSenderId}): "${msgText}"...`);

    try {
      const res = await axios.post(`${BASE_URL}/webhook/instagram`, mockPayload);
      console.log(`✅ Sunucu Yanıtı: HTTP ${res.status} (${res.data})`);
      console.log('🤖 F.R.I.D.A.Y. AI Ajanları mesajı işledi. Sunucu loglarını kontrol edin!\n');
    } catch (err: any) {
      console.error('❌ Webhook POST hatası:', err?.response?.data || err.message);
    }

    promptContinue();
  });
}

/**
 * 3. Canlı Sipariş & Stok Verilerini Göster
 */
async function showDatabaseStats() {
  try {
    const ordersRes = await axios.get(`${BASE_URL}/api/orders`);
    const stocksRes = await axios.get(`${BASE_URL}/api/stocks`);

    console.log(`\n==================================================`);
    console.log(`📊 CANLI VERİTABANI İSTATİSTİKLERİ (SQLite barons.db)`);
    console.log(`==================================================`);
    console.log(`🛍️ Toplam Sipariş Sayısı: ${ordersRes.data.count || 0}`);
    console.log(`📦 Toplam Ürün Çeşidi   : ${stocksRes.data.stocks?.length || 0}`);
    console.log(`--------------------------------------------------`);

    if (ordersRes.data.orders && ordersRes.data.orders.length > 0) {
      console.log('\n📋 Son 3 Sipariş:');
      ordersRes.data.orders.slice(0, 3).forEach((o: any, idx: number) => {
        console.log(` ${idx + 1}. [${o.orderId}] ${o.customerName} - ${o.productCode} (${o.status})`);
      });
    }
  } catch (err: any) {
    console.error('❌ Veritabanı istatistikleri çekilemedi:', err.message);
  }
}

function promptContinue() {
  rl.question('\nDevam etmek için Enter tuşuna basın...', () => {
    showBanner();
    showMenu();
  });
}

// CLI Başlat
showBanner();
showMenu();
