"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIService = void 0;
const openai_1 = require("@langchain/openai");
const tools_1 = require("@langchain/core/tools");
const messages_1 = require("@langchain/core/messages");
const env_1 = require("../config/env");
const stock_service_1 = require("./stock.service");
const order_service_1 = require("./order.service");
const telegram_service_1 = require("./telegram.service");
const facebook_service_1 = require("./facebook.service");
const db_1 = require("../database/db");
/**
 * Multi-Tenant n8n LangChain AI Service (Strict Store Isolation & Security)
 */
class AIService {
    static sessions = new Map();
    static validateStoreId(storeId) {
        if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
            throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
        }
    }
    static getApiKey() {
        return (process.env.OPENAI_API_KEY || env_1.env.openaiApiKey || '').trim().replace(/^["']|["']$/g, '');
    }
    static getSessionContext(senderId, storeSlug, storeId, channel = 'instagram') {
        this.validateStoreId(storeId);
        const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
        if (!this.sessions.has(key)) {
            this.sessions.set(key, { storeId, history: [], cart: [], checkoutConfirmed: false });
        }
        const ctx = this.sessions.get(key);
        if (!ctx.cart)
            ctx.cart = [];
        if (typeof ctx.checkoutConfirmed !== 'boolean')
            ctx.checkoutConfirmed = false;
        ctx.storeId = storeId;
        return ctx;
    }
    /**
     * Kalıcı Sohbet Veritabanı ve Token Kullanım Takibi (ai_usage) - Multi-Tenant Scoped
     */
    static getOrCreateConversation(storeId, externalUserId) {
        this.validateStoreId(storeId);
        try {
            let conv = db_1.db.prepare('SELECT id FROM conversations WHERE store_id = ? AND external_user_id = ?').get(storeId, externalUserId);
            if (!conv) {
                const res = db_1.db.prepare('INSERT INTO conversations (store_id, external_user_id) VALUES (?, ?)').run(storeId, externalUserId);
                return Number(res.lastInsertRowid);
            }
            return conv.id;
        }
        catch {
            return 1;
        }
    }
    static persistMessage(conversationId, senderType, text) {
        try {
            db_1.db.prepare('INSERT INTO messages (conversation_id, sender_type, text) VALUES (?, ?, ?)').run(conversationId, senderType, text);
        }
        catch { }
    }
    static logAiUsage(storeId, conversationId, model, inputTokens, outputTokens, latency) {
        this.validateStoreId(storeId);
        try {
            const totalTokens = inputTokens + outputTokens;
            const isMini = model.includes('mini');
            const inputCost = (inputTokens / 1_000_000) * (isMini ? 0.15 : 2.50);
            const outputCost = (outputTokens / 1_000_000) * (isMini ? 0.60 : 10.00);
            const estimatedCost = (inputCost + outputCost) * 35.0;
            db_1.db.prepare(`
        INSERT INTO ai_usage (store_id, conversation_id, model, input_tokens, output_tokens, total_tokens, estimated_cost, latency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(storeId, conversationId, model, inputTokens, outputTokens, totalTokens, estimatedCost, latency);
        }
        catch (e) {
            console.warn('[AI Usage Tracker] Token logging error:', e.message);
        }
    }
    /**
     * Yapay Zeka Destekli Akıllı Veri Ayıklama Motoru (AI Extractor)
     */
    static async extractSessionDataWithAI(senderId, userText, apiKey, storeSlug, storeId, channel) {
        const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
        try {
            const extractorModel = new openai_1.ChatOpenAI({
                openAIApiKey: apiKey,
                modelName: 'gpt-4o-mini',
                temperature: 0
            });
            const extractionPrompt = `
Müşterinin gönderdiği mesajdan ad-soyad, telefon, adres, ürün kodu, beden ve adet verilerini ayıkla.

Müşteri Mesajı: "${userText}"

Yalnızca aşağıdaki JSON yapısını döndür (bilinmeyen alanlar için null ver):
{
  "customerName": "Müşterinin Adı ve Soyadı",
  "customerPhone": "Müşterinin Telefon Numarası",
  "address": "Müşterinin Açık Adresi",
  "productCode": "Varsa Ürün Kodu",
  "size": "Varsa Beden",
  "quantity": "Varsa Adet Sayısı"
}
`;
            const response = await extractorModel.invoke([new messages_1.HumanMessage(extractionPrompt)]);
            const text = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                if (data.customerName && data.customerName !== 'null' && data.customerName.trim().length > 1) {
                    ctx.customerName = data.customerName.trim();
                }
                if (data.customerPhone && data.customerPhone !== 'null') {
                    ctx.customerPhone = data.customerPhone.trim();
                }
                if (data.address && data.address !== 'null' && data.address.trim().length > 3) {
                    ctx.address = data.address.trim();
                }
                if (data.productCode && data.productCode !== 'null') {
                    ctx.productCode = data.productCode.trim().toUpperCase();
                }
                if (data.size && data.size !== 'null') {
                    ctx.size = data.size.trim().toUpperCase();
                }
                if (data.quantity && data.quantity !== 'null' && !isNaN(Number(data.quantity))) {
                    ctx.quantity = Number(data.quantity);
                }
            }
        }
        catch (e) {
            console.warn('[AI Extractor] ⚠️ AI veri ayıklama hatası:', e.message);
        }
    }
    /**
     * Mesajdaki kodu, AI tahmininden bağımsız olarak yalnızca bu mağazanın ürünleriyle eşleştirir.
     * Kısa kod (HBL) asla rastgele bir beden varyantına (HBL-M) dönüştürülmez.
     */
    static hydrateProductCodeFromMessage(userText, storeId, ctx) {
        const rawText = String(userText || '').trim();
        if (!rawText)
            return;
        const rows = db_1.db.prepare(`
      SELECT product_code, short_code
      FROM products
      WHERE store_id = ?
    `).all(storeId);
        const normalizedText = rawText.toUpperCase();
        const containsExactCode = (value) => {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|[^A-Z0-9-])${escaped}($|[^A-Z0-9-])`, 'i').test(normalizedText);
        };
        // Tam kod yazıldıysa olduğu gibi koru. Aksi durumda yalnız kısa kodu sakla;
        // beden geldikten sonra ilgili tam varyant sorgulanır.
        const fullCodeMatch = rows.find(row => containsExactCode(String(row.product_code || '')));
        const shortCodeMatch = rows.find(row => containsExactCode(String(row.short_code || '')));
        if (fullCodeMatch?.product_code) {
            ctx.productCode = String(fullCodeMatch.product_code).trim().toUpperCase();
        }
        else if (shortCodeMatch?.short_code) {
            ctx.productCode = String(shortCodeMatch.short_code).trim().toUpperCase();
        }
    }
    /**
     * Alt Düğüm Araçlarını Tanımlar (Strict Store Isolation)
     */
    static createLeafTools(senderId, storeSlug, storeId, channel) {
        const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
        // STOK Tool
        const stokTool = new tools_1.DynamicTool({
            name: 'STOK',
            description: 'Ürün kodu ve BEDEN bilgisi mevcutsa doğru varyantın stok ve fiyatını kontrol eder.',
            func: async (input) => {
                try {
                    let request = {};
                    try {
                        request = typeof input === 'object' ? input : JSON.parse(input);
                    }
                    catch {
                        request = { productCode: input };
                    }
                    const query = String(request.productCode || request.query || ctx.productCode || '').trim();
                    const requestedSize = String(request.size || ctx.size || '').trim().toUpperCase();
                    // Fiyat yalnızca ürünün tam varyantı (ürün kodu + beden) doğrulandığında verilir.
                    // Böylece farklı beden/varyantın fiyatı müşteriye gösterilmez.
                    if (query && requestedSize) {
                        const product = db_1.db.prepare(`
              SELECT product_code, short_code, name, size, price, stock
              FROM products
              WHERE store_id = ?
                AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
                AND UPPER(size) = ?
              LIMIT 1
            `).get(storeId, query.toUpperCase(), query.toUpperCase(), requestedSize);
                        if (!product) {
                            return JSON.stringify({ exists: false, message: `${query} kodlu ${requestedSize} beden ürün bulunamadı.` });
                        }
                        const price = Number(product.price);
                        if (!Number.isFinite(price) || price < 0) {
                            return JSON.stringify({ exists: false, message: `${product.product_code} için geçerli bir fiyat tanımlı değil. Lütfen mağaza yöneticisiyle iletişime geçin.` });
                        }
                        ctx.productCode = product.product_code;
                        ctx.size = product.size;
                        return JSON.stringify({
                            exists: true,
                            inStock: Number(product.stock) > 0,
                            productName: product.name,
                            productCode: product.product_code,
                            size: product.size,
                            price,
                            stock: Number(product.stock),
                            message: Number(product.stock) > 0 ? 'Stokta mevcuttur.' : 'Stokta kalmamıştır.'
                        });
                    }
                    const result = await stock_service_1.StockService.checkStock(storeId, query);
                    if (!result.exists)
                        return JSON.stringify({ exists: false, message: 'Ürün bulunamadı.' });
                    if (result.product?.productCode) {
                        ctx.productCode = result.product.productCode;
                    }
                    return JSON.stringify({
                        exists: true,
                        inStock: result.inStock,
                        productName: result.product?.name,
                        productCode: result.product?.productCode || ctx.productCode,
                        size: result.product?.size || ctx.size,
                        availableSizes: result.product?.availableSizes,
                        message: result.inStock ? 'Stokta mevcuttur.' : 'Stokta kalmamıştır.'
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            }
        });
        // SEPETE_EKLE Tool (Store Isolated)
        const sepeteEkleTool = new tools_1.DynamicTool({
            name: 'SEPETE_EKLE',
            description: 'Müşterinin istediği ürünü, bedenini ve adetini sepete ekler.',
            func: async (input) => {
                try {
                    let data = {};
                    try {
                        data = typeof input === 'object' ? input : JSON.parse(input);
                    }
                    catch {
                        data = {};
                    }
                    const pCode = String(data.productCode || '').trim().toUpperCase();
                    const pSize = String(data.size || '').trim().toUpperCase();
                    const pQty = Number(data.quantity);
                    if (!pCode || !pSize || !Number.isInteger(pQty) || pQty <= 0) {
                        return JSON.stringify({ success: false, message: 'Sepete eklemek için ürün kodu, beden ve adet zorunludur.' });
                    }
                    const pCodeUpper = pCode.toUpperCase();
                    const prod = db_1.db.prepare(`
            SELECT * FROM products 
            WHERE store_id = ?
              AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
              AND UPPER(size) = ?
            LIMIT 1
          `).get(storeId, pCodeUpper, pCodeUpper, pSize);
                    if (!prod) {
                        return JSON.stringify({ success: false, message: `${pCode} kodlu ${pSize} beden ürünü bulunamadı.` });
                    }
                    const unitPrice = Number(prod.price);
                    const productName = prod.name;
                    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
                        return JSON.stringify({ success: false, message: `${productName} için geçerli bir fiyat tanımlı değil. Siparişe eklenemedi.` });
                    }
                    if (Number(prod.stock) < pQty) {
                        return JSON.stringify({ success: false, message: `${productName} (${pSize}) stokta tükendiği için sepete eklenemedi.` });
                    }
                    const canonicalProductCode = String(prod.product_code).toUpperCase();
                    const existingIdx = ctx.cart.findIndex(i => i.productCode === canonicalProductCode && i.size === pSize);
                    if (existingIdx >= 0) {
                        ctx.cart[existingIdx].quantity += pQty;
                    }
                    else {
                        ctx.cart.push({
                            productCode: canonicalProductCode,
                            productName: productName,
                            size: pSize,
                            quantity: pQty,
                            unitPrice: unitPrice
                        });
                    }
                    ctx.productCode = canonicalProductCode;
                    ctx.size = pSize;
                    ctx.quantity = pQty;
                    ctx.checkoutConfirmed = false;
                    const cartSubtotal = ctx.cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
                    const shippingSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId);
                    const thresholdSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId);
                    const shippingFee = Number(shippingSetting?.value);
                    const freeShippingThreshold = Number(thresholdSetting?.value);
                    const shippingFeeEstimate = Number.isFinite(freeShippingThreshold) && cartSubtotal >= freeShippingThreshold
                        ? 0
                        : (Number.isFinite(shippingFee) ? shippingFee : 49);
                    const totalEstimate = cartSubtotal + shippingFeeEstimate;
                    return JSON.stringify({
                        success: true,
                        message: `${productName} (Beden: ${pSize}, Adet: ${pQty}) sepete eklendi!`,
                        cartItemCount: ctx.cart.length,
                        cartTotalItems: ctx.cart.reduce((sum, i) => sum + i.quantity, 0),
                        cartSubtotal: cartSubtotal,
                        shippingFeeEstimate: shippingFeeEstimate,
                        totalEstimate: totalEstimate,
                        priceMessage: `Ara Toplam: ${cartSubtotal.toFixed(2)} TL | Kargo: ${shippingFeeEstimate === 0 ? 'ÜCRETSİZ' : shippingFeeEstimate + ' TL'} | Tahmini Toplam: ${totalEstimate.toFixed(2)} TL`,
                        cart: ctx.cart
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            }
        });
        const sepetOnaylaTool = new tools_1.DynamicTool({
            name: 'SEPET_ONAYLA',
            description: 'Müşteri sepet özetini açıkça onayladıktan sonra ödeme bilgilerini isteme aşamasını başlatır.',
            func: async () => {
                if (!ctx.cart || ctx.cart.length === 0) {
                    return JSON.stringify({ success: false, message: 'Onaylanacak sepet bulunmuyor. Önce ürün kodu, beden ve adet ile ürün ekleyin.' });
                }
                ctx.checkoutConfirmed = true;
                // Contact details must be collected only after the cart is approved.
                delete ctx.customerName;
                delete ctx.customerPhone;
                delete ctx.address;
                return JSON.stringify({
                    success: true,
                    checkoutConfirmed: true,
                    message: 'Sepet onaylandı. Siparişi tamamlamak için müşteriden ad soyad, telefon numarası ve açık teslimat adresini isteyin.'
                });
            }
        });
        // SEPET_GORUNTULE Tool
        const sepetGoruntuleTool = new tools_1.DynamicTool({
            name: 'SEPET_GORUNTULE',
            description: 'Müşterinin sepetindeki tüm ürünleri ve ara toplamı listeler.',
            func: async () => {
                if (!ctx.cart || ctx.cart.length === 0) {
                    return JSON.stringify({ cartEmpty: true, message: 'Sepetiniz şu an boş.' });
                }
                const cartSubtotal = ctx.cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
                return JSON.stringify({
                    cartEmpty: false,
                    cart: ctx.cart,
                    cartSubtotal: cartSubtotal
                });
            }
        });
        // KAYIT Tool (Store Isolated)
        const kayitTool = new tools_1.DynamicTool({
            name: 'KAYIT',
            description: 'Müşterinin 3 Bilgisi (İsim, Tel, Adres) Tamamlandıysa Toplu Siparişi Oluşturur.',
            func: async (input) => {
                try {
                    let data = {};
                    try {
                        data = typeof input === 'object' ? input : JSON.parse(input);
                    }
                    catch {
                        data = {};
                    }
                    const customerName = data.customerName || ctx.customerName;
                    const customerPhone = data.customerPhone || ctx.customerPhone;
                    const address = data.address || ctx.address;
                    if (!ctx.cart || ctx.cart.length === 0) {
                        return JSON.stringify({ success: false, orderCreated: false, message: 'Sipariş oluşturmak için önce ürün kodu, beden ve adet ile sepet oluşturulmalıdır.' });
                    }
                    if (!ctx.checkoutConfirmed) {
                        return JSON.stringify({ success: false, orderCreated: false, message: 'Sipariş oluşturulmadan önce sepet özeti müşteriye gösterilmeli ve müşterinin açık onayı alınmalıdır.' });
                    }
                    const missingFields = [];
                    if (!customerName || customerName.trim().length <= 1)
                        missingFields.push('İsim Soyisim');
                    if (!customerPhone || customerPhone.replace(/\D/g, '').length < 10)
                        missingFields.push('Telefon Numarası');
                    if (!address || address.trim().length < 10)
                        missingFields.push('Açık Teslimat Adresi');
                    if (missingFields.length > 0) {
                        return JSON.stringify({
                            success: false,
                            orderCreated: false,
                            missingFields: missingFields,
                            message: `Sipariş oluşturulamadı! Eksik bilgiler: ${missingFields.join(', ')}. Lütfen bu bilgileri müşteriden talep edin.`
                        });
                    }
                    const subtotal = ctx.cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
                    const totalQuantity = ctx.cart.reduce((sum, item) => sum + item.quantity, 0);
                    // Ayarlardan Kargo Ücreti (Store Isolated)
                    const shippingSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId);
                    const thresholdSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId);
                    const loyaltyThresholdSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'loyalty_threshold'").get(storeId);
                    let shippingFee = Number(shippingSetting?.value || 49);
                    const freeThreshold = Number(thresholdSetting?.value || 1500);
                    const loyaltyThreshold = Number(loyaltyThresholdSetting?.value || 2000);
                    if (subtotal >= freeThreshold) {
                        shippingFee = 0;
                    }
                    let discount = 0;
                    let appliedLoyaltyReward = false;
                    // Müşterinin Instagram ID'sine tanımlı mağaza bazlı VIP Ödülü
                    const userReward = db_1.db.prepare('SELECT * FROM user_rewards WHERE store_id = ? AND sender_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1').get(storeId, senderId);
                    if (userReward) {
                        discount = (subtotal * (userReward.discount_percent / 100));
                        appliedLoyaltyReward = true;
                        db_1.db.prepare('UPDATE user_rewards SET is_used = 1, used_at = CURRENT_TIMESTAMP WHERE store_id = ? AND id = ?').run(storeId, userReward.id);
                    }
                    else {
                        const activeCampaigns = db_1.db.prepare('SELECT * FROM campaigns WHERE store_id = ? AND active = 1').all(storeId);
                        for (const c of activeCampaigns) {
                            if (c.code === 'BARONS10') {
                                discount += (subtotal * 0.10);
                            }
                        }
                    }
                    const totalPrice = Math.max(0, subtotal + shippingFee - discount);
                    let earnedNewLoyaltyReward = false;
                    const autoVipSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'auto_vip_reward_enabled'").get(storeId);
                    const isAutoVipEnabled = autoVipSetting && (autoVipSetting.value === '1' || autoVipSetting.value === 'true');
                    if (isAutoVipEnabled && subtotal >= loyaltyThreshold) {
                        const rewardCode = 'YINEBEKLERIZ';
                        db_1.db.prepare(`
              INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount)
              VALUES (?, ?, ?, 20.0, ?)
            `).run(storeId, senderId, rewardCode, loyaltyThreshold);
                        earnedNewLoyaltyReward = true;
                        const autoDmText = `🎉 TEBRİKLER / VIP ÖDÜL KAZANDINIZ!\nSayın ${customerName.trim()}, profilinize özel %20 VIP İNDİRİM tanımlanmıştır! (Ödül Kodu: ${rewardCode})\nKeyifli alışverişler dileriz! 🎁✨`;
                        facebook_service_1.FacebookService.sendMessage(senderId, autoDmText, storeId).catch(e => console.error('[Auto Reward DM Error]:', e.message));
                    }
                    const combinedProductCode = ctx.cart.map(i => `${i.productCode} (${i.size}) x${i.quantity}`).join(', ');
                    const combinedProductName = ctx.cart.map(i => `${i.productName} (${i.size})`).join(', ');
                    const order = await order_service_1.OrderService.createOrder(storeId, {
                        storeId: storeId,
                        customerName: customerName,
                        customerPhone: customerPhone,
                        address: address,
                        productCode: combinedProductCode,
                        productName: combinedProductName,
                        size: ctx.cart.map(i => i.size).join(','),
                        quantity: totalQuantity,
                        unitPrice: subtotal / Math.max(1, totalQuantity),
                        senderId: senderId
                    });
                    db_1.db.prepare(`
            UPDATE orders 
            SET unit_price = ?, shipping_fee = ?, discount = ?, total_price = ?
            WHERE store_id = ? AND order_id = ?
          `).run(subtotal / Math.max(1, totalQuantity), shippingFee, discount, totalPrice, storeId, order.orderId);
                    const cartSummaryText = ctx.cart.map(i => {
                        const lineTotal = i.unitPrice * i.quantity;
                        return `• ${i.productName} (${i.size}) x${i.quantity} - ${lineTotal.toLocaleString('tr-TR')} TL`;
                    }).join('\n');
                    ctx.cart = [];
                    ctx.checkoutConfirmed = false;
                    delete ctx.customerName;
                    delete ctx.customerPhone;
                    delete ctx.address;
                    return JSON.stringify({
                        success: true,
                        orderCreated: true,
                        orderId: order.orderId,
                        appliedLoyaltyReward,
                        earnedNewLoyaltyReward,
                        subtotal,
                        shippingFee,
                        discount,
                        totalPrice,
                        priceDetails: `Sipariş Özeti:\n${cartSummaryText}\n\nAra Toplam: ${subtotal.toFixed(2)} TL\nKargo: ${shippingFee === 0 ? 'ÜCRETSİZ' : shippingFee.toFixed(2) + ' TL'}\nİndirim: ${discount > 0 ? '-' + discount.toFixed(2) + ' TL' : '0 TL'}\nNET ÖDENECEK TOPLAM: ${totalPrice.toFixed(2)} TL`,
                        loyaltyNotice: earnedNewLoyaltyReward
                            ? `🎉 TEBRİKLER! ${loyaltyThreshold} TL ve üzeri sipariş verdiğiniz için Instagram hesabınıza tanımlı VIP İNDİRİM HAKKI KAZANDINIZ!`
                            : ''
                    });
                }
                catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            }
        });
        // MESAJ Tool
        const mesajTool = new tools_1.DynamicTool({
            name: 'MESAJ',
            description: 'İşletme sahibine Telegram üzerinden HTML bildirim yollar.',
            func: async (input) => {
                try {
                    let data = typeof input === 'object' ? input : JSON.parse(input);
                    await telegram_service_1.TelegramService.notifyOrder(storeId, {
                        customerName: data.customerName || ctx.customerName || 'Müşteri',
                        customerPhone: data.customerPhone || ctx.customerPhone || '',
                        address: data.address || ctx.address || '',
                        productCode: data.productCode || ctx.productCode || '',
                        productName: data.productName || data.productCode || ctx.productCode || '',
                        size: data.size || ctx.size || '',
                        quantity: data.quantity || 1,
                        orderId: data.orderId || 'SIP-123',
                        createdAt: new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
                    });
                    return 'Telegram bildirimi gönderildi.';
                }
                catch (e) {
                    return `Telegram hatası: ${e.message}`;
                }
            }
        });
        // GUNCELLE Tool
        const guncelleTool = new tools_1.DynamicTool({
            name: 'GUNCELLE',
            description: 'Sipariş onaylandığında stok miktarını günceller.',
            func: async (input) => {
                try {
                    let data = typeof input === 'object' ? input : JSON.parse(input);
                    const pCode = data.productCode || ctx.productCode;
                    if (pCode) {
                        await stock_service_1.StockService.deductStock(storeId, pCode, Number(data.quantity) || 1);
                    }
                    return 'Stok başarıyla güncellendi.';
                }
                catch (e) {
                    return `Stok güncelleme hatası: ${e.message}`;
                }
            }
        });
        return { stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, mesajTool, guncelleTool };
    }
    static createBilgilendirmeSubAgent(model, mesajTool) {
        return new tools_1.DynamicTool({
            name: 'BILGILENDIRME',
            description: 'Sipariş oluşturulduğunda Telegram bildirimi gönderir.',
            func: async (input) => {
                return await mesajTool.invoke(input);
            }
        });
    }
    static createSiparisSubAgent(model, stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, bilgilendirmeTool) {
        return new tools_1.DynamicTool({
            name: 'SIPARIS',
            description: 'Sipariş akışını yürütür. action yalnızca stok, sepete_ekle, sepet_goruntule, sepet_onayla veya kayit olabilir. sepete_ekle için productCode, size ve quantity zorunludur. sepet_onayla yalnız müşteri açıkça sepeti onayladığında, kayit yalnız onay sonrası tam müşteri bilgileri varken kullanılır.',
            func: async (input) => {
                try {
                    let data = typeof input === 'object' ? input : JSON.parse(input);
                    const action = data.action || 'stok';
                    if (action === 'sepete_ekle') {
                        return await sepeteEkleTool.invoke(JSON.stringify(data));
                    }
                    else if (action === 'sepet_goruntule') {
                        return await sepetGoruntuleTool.invoke('');
                    }
                    else if (action === 'sepet_onayla') {
                        return await sepetOnaylaTool.invoke('');
                    }
                    else if (action === 'kayit') {
                        const res = await kayitTool.invoke(JSON.stringify(data));
                        if (res.includes('"orderCreated":true')) {
                            await bilgilendirmeTool.invoke(JSON.stringify(data));
                        }
                        return res;
                    }
                    else {
                        return await stokTool.invoke(JSON.stringify(data));
                    }
                }
                catch (e) {
                    return JSON.stringify({ error: e.message });
                }
            }
        });
    }
    static createStokManSubAgent(model, guncelleTool) {
        return new tools_1.DynamicTool({
            name: 'STOK_MAN',
            description: 'Stok miktarını eksiltir.',
            func: async (input) => {
                return await guncelleTool.invoke(input);
            }
        });
    }
    /**
     * Mesaj İşleme Ana Metodu (Strict Store Isolation & Security)
     */
    static async processMessage(senderId, userMessage, storeSlug, storeId, channel = 'instagram') {
        this.validateStoreId(storeId);
        const apiKey = this.getApiKey();
        if (!apiKey) {
            return {
                reply: "Merhaba! Lütfen geçerli bir OPENAI_API_KEY tanımlayınız.",
                tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
                toolTraces: [],
                cart: []
            };
        }
        let promptTokens = 0;
        let completionTokens = 0;
        const toolTraces = [];
        const trackUsage = (res, currentMessagesCount) => {
            if (res?.usage_metadata) {
                promptTokens += res.usage_metadata.input_tokens || 0;
                completionTokens += res.usage_metadata.output_tokens || 0;
            }
            else {
                promptTokens += Math.ceil(currentMessagesCount * 120);
                completionTokens += Math.ceil((typeof res?.content === 'string' ? res.content.length : 100) / 4);
            }
        };
        try {
            await this.extractSessionDataWithAI(senderId, userMessage, apiKey, storeSlug, storeId, channel);
            const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
            this.hydrateProductCodeFromMessage(userMessage, storeId, ctx);
            // Veritabanından Aktif Kampanyaları Çek (Store Isolated)
            const activeCampaigns = db_1.db.prepare(`
        SELECT title, description, code, start_date, end_date 
        FROM campaigns 
        WHERE store_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '' OR end_date >= DATE('now'))
      `).all(storeId);
            const shippingSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId);
            const thresholdSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId);
            const loyaltyThresholdSetting = db_1.db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'loyalty_threshold'").get(storeId);
            const userReward = db_1.db.prepare("SELECT * FROM user_rewards WHERE store_id = ? AND sender_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1").get(storeId, senderId);
            const shippingFee = shippingSetting?.value || '49';
            const freeThreshold = thresholdSetting?.value || '1500';
            const loyaltyThreshold = loyaltyThresholdSetting?.value || '2000';
            let rewardText = "";
            if (userReward) {
                rewardText = `🎁 **MÜŞTERİNİN İNSTAGRAM HESABINA TANIMLI ÖZEL ÖDÜL:** Müşterinin hesabına tanımlı %${userReward.discount_percent} VIP İNDİRİM HAKKI vardır! Bu siparişinde müşteri özel %${userReward.discount_percent} VIP indirimi kazanır.`;
            }
            else {
                rewardText = `💡 **GELECEK SİPARİŞ İNDİRİM HAKKI KAZANMA:** Müşterinin bu siparişi ${loyaltyThreshold} TL ve üzeri olursa, bir sonraki siparişinde geçerli %20 VIP İNDİRİM HAKKI kazanacaktır!`;
            }
            const campaignsText = activeCampaigns.length > 0
                ? activeCampaigns.map(c => `- ${c.title}: ${c.description} (Kod: ${c.code || 'Yok'})`).join('\n')
                : 'Şu an aktif genel kampanya bulunmamaktadır.';
            const cartText = ctx.cart.length > 0
                ? ctx.cart.map(i => `• ${i.productName} (${i.size}) x${i.quantity} - ${i.unitPrice * i.quantity} TL`).join('\n')
                : 'Sepetiniz şu an boş.';
            const orderContext = ctx.productCode
                ? `Müşteri ürün kodunu zaten verdi: ${ctx.productCode}. Bu kısa kod olabilir; ASLA kendin HBL-M gibi bir beden varyantı seçme veya önerme. Ürün kodunu tekrar sorma. Beden eksikse yalnız bedeni iste. Beden geldiyse SIPARIS action=stok ile ürün kodu ve bedeni gönder; doğrulanan stok/fiyat bilgisinden sonra yalnız adet iste.`
                : 'Henüz doğrulanmış bir ürün kodu yok. Yalnızca ürün kodunu iste.';
            const model = new openai_1.ChatOpenAI({
                openAIApiKey: apiKey,
                modelName: env_1.env.openaiModel || 'gpt-4o',
                temperature: 0.2
            });
            const { stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, mesajTool, guncelleTool } = this.createLeafTools(senderId, storeSlug, storeId, channel);
            const bilgilendirmeAgentTool = this.createBilgilendirmeSubAgent(model, mesajTool);
            const siparisAgentTool = this.createSiparisSubAgent(model, stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, bilgilendirmeAgentTool);
            const stokManAgentTool = this.createStokManSubAgent(model, guncelleTool);
            const rootTools = [siparisAgentTool, stokManAgentTool];
            const boundRootModel = model.bindTools(rootTools);
            const systemPrompt = new messages_1.SystemMessage(`
<görev>
Sen Mağaza Müşteri Danışmanısın (F.R.I.D.A.Y.). Müşterilerin ürün sorularını yanıtlar, ürünleri SEPETE EKLER ve müşteri "isteklerim bu kadar / siparişi tamamla" dediğinde TOPLU SİPARİŞİ oluşturursun.
</görev>

<KATI_GÜVENLİK_VE_SEPET_KURALLARI>
<AKTIF_SIPARIS_BAGLAMI>
${orderContext}
Mevcut beden: ${ctx.size || 'yok'}
Mevcut adet: ${ctx.quantity || 'yok'}
</AKTIF_SIPARIS_BAGLAMI>

ZORUNLU SIPARIS SIRASI — bu kural diğer tüm sipariş talimatlarının önündedir:
1. Önce yalnız ürün kodunu iste. Kod olmadan beden, adet veya kişisel bilgi isteme.
2. Koddan sonra yalnız beden iste. Kısa kod verildiyse asla kendin beden/varyant seçme.
3. Beden gelir gelmez ürün kodu + beden ile STOK sorgusu yap; doğru varyantın stok ve fiyatını doğrula. Ardından yalnız adet iste.
4. Ürün kodu, beden ve adet eksiksiz olmadan SEPETE_EKLE çağırma.
5. Sepete ekledikten sonra sepet özetini, kargoyu ve toplamı göster. Açıkça "Sepetinizi onaylıyor musunuz?" diye sor.
6. Müşteri açıkça onay vermeden SEPET_ONAYLA veya KAYIT çağırma.
7. Açık onaydan sonra SEPET_ONAYLA çağır; ardından ad soyad, telefon numarası ve açık teslimat adresini sırayla iste.
8. Ad soyad, en az 10 haneli telefon ve en az 10 karakterlik açık adres tamamlanmadan KAYIT çağırma; sipariş oluşturuldu deme.
9. Müşteri sepeti onaylamadan kişisel bilgileri isteme veya kullanma.

1. 🛒 **SEPET SİSTEMİ (ÇOKLU ÜRÜN DESTEĞİ):**
   - Müşteri bir ürün seçtiğinde SEPETE_EKLE aracını çağır ve ürünü sepete ekle.
   - Müşteri "isteklerim bu kadar", "siparişi tamamla" dediğinde KAYIT aracını çağırarak siparişi kaydet.
   - Müşterinin Mevcut Sepet Durumu:
${cartText}

2. 🎁 **VİP İNDİRİM SİSTEMİ:**
${rewardText}

3. 🔒 **STOK SORGULAMA KURALI:**
   - Müşteri HANGİ BEDEN ve KAÇ ADET ilgilendiğini söylemeden STOK SORGULAMASI YAPMA!

4. 🔒 **TOPLU SİPARİŞ VE BİLGİ İSTEME KURALI:**
   👉 **SEPETTEKİ ÜRÜNLERİ, KARGO DURUMUNU VE TOPLAM SİPARİŞ TUTARINI (TL) MUTLAKA AÇIKÇA BELİRT!**

5. 🎉 **KAMPANYALAR VE İNDİRİMLER:**
${campaignsText}

6. 🚚 **KARGO ÜCRETİ VE FİYATLANDIRMA:**
   - Standart Kargo Ücreti: ${shippingFee} TL.
   - ${freeThreshold} TL ve üzeri siparişlerde KARGO ÜCRETSİZDİR!
</KATI_GÜVENLİK_VE_SEPET_KURALLARI>
`);
            ctx.history.push(new messages_1.HumanMessage(userMessage));
            if (ctx.history.length > 16) {
                ctx.history.splice(0, ctx.history.length - 16);
            }
            let messages = [systemPrompt, ...ctx.history];
            let response = await boundRootModel.invoke(messages);
            trackUsage(response, messages.length);
            messages.push(response);
            let count = 0;
            while (response.tool_calls && response.tool_calls.length > 0 && count < 4) {
                count++;
                for (const tc of response.tool_calls) {
                    const startTime = Date.now();
                    let toolResult = "";
                    let status = 'SUCCESS';
                    try {
                        if (tc.name === 'SIPARIS') {
                            toolResult = await siparisAgentTool.invoke(JSON.stringify(tc.args));
                        }
                        else if (tc.name === 'STOK_MAN') {
                            toolResult = await stokManAgentTool.invoke(JSON.stringify(tc.args));
                        }
                        else {
                            toolResult = "Bilinmeyen araç";
                        }
                    }
                    catch (err) {
                        status = 'FAILED';
                        toolResult = `Araç hatası: ${err.message}`;
                    }
                    const durationMs = Date.now() - startTime;
                    toolTraces.push({
                        toolName: tc.name,
                        args: tc.args,
                        storeId: storeId,
                        result: toolResult,
                        durationMs: durationMs,
                        status: status
                    });
                    messages.push(new messages_1.ToolMessage({ content: toolResult, tool_call_id: tc.id }));
                }
                response = await boundRootModel.invoke(messages);
                trackUsage(response, messages.length);
                messages.push(response);
            }
            const finalOutput = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
            ctx.history.push(new messages_1.AIMessage(finalOutput));
            const totalTokens = promptTokens + completionTokens;
            const costUsd = (promptTokens * 0.0000025) + (completionTokens * 0.00001);
            return {
                reply: finalOutput,
                tokens: { promptTokens, completionTokens, totalTokens, costUsd },
                toolTraces,
                cart: ctx.cart
            };
        }
        catch (error) {
            console.error('[AIService] ❌ İşlem Hatası:', error);
            return {
                reply: "Üzgünüm, şu an bağlantıda geçici bir yoğunluk var. Lütfen biraz sonra tekrar deneyiniz.",
                tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
                toolTraces: [],
                cart: []
            };
        }
    }
    static resetTestSession(storeId, storeSlug, senderId, channel = 'TEST', action = 'all') {
        const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
        if (this.sessions.has(key)) {
            const ctx = this.sessions.get(key);
            if (action === 'cart' || action === 'all') {
                ctx.cart = [];
            }
            if (action === 'conversation' || action === 'all') {
                ctx.history = [];
            }
            if (action === 'all') {
                this.sessions.delete(key);
            }
        }
    }
    static getSessionInfo(storeId, storeSlug, senderId, channel = 'TEST') {
        const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
        const ctx = this.sessions.get(key) || { storeId, history: [], cart: [] };
        return {
            cart: ctx.cart || [],
            historyCount: ctx.history ? ctx.history.length : 0
        };
    }
}
exports.AIService = AIService;
