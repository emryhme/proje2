import { ChatOpenAI } from '@langchain/openai';
import { DynamicTool } from '@langchain/core/tools';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { env } from '../config/env';
import { StockService } from './stock.service';
import { OrderService } from './order.service';
import { TelegramService } from './telegram.service';
import { FacebookService } from './facebook.service';
import { extractProductCode } from '../utils/regex.util';
import { db } from '../database/db';

export interface CartItem {
  productCode: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
}

export interface ToolTraceItem {
  toolName: string;
  args: any;
  storeId: number;
  result: any;
  durationMs: number;
  status: 'SUCCESS' | 'FAILED';
}

interface SessionContext {
  storeId: number;
  history: BaseMessage[];
  productCode?: string;
  size?: string;
  quantity?: number;
  customerName?: string;
  customerPhone?: string;
  address?: string;
  cart: CartItem[];
  checkoutConfirmed: boolean;
  variantVerified: boolean;
}

/**
 * Multi-Tenant n8n LangChain AI Service (Strict Store Isolation & Security)
 */
export class AIService {
  private static sessions: Map<string, SessionContext> = new Map();

  /**
   * LangChain DynamicTool bazen argümanları doğrudan alanlar yerine
   * { input: "sepete_ekle productCode=HBL-M size=M quantity=1" } biçiminde gönderir.
   * Her iki biçimi de tek ve güvenilir SIPARIS komutuna dönüştürür.
   */
  private static normalizeSiparisToolInput(input: any): any {
    let data: any = input;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = { input: data }; }
    }
    if (!data || typeof data !== 'object') data = {};

    if (typeof data.input !== 'string' || !data.input.trim()) return data;

    const command = data.input.trim();
    if (command.startsWith('{')) {
      try { return { ...data, ...JSON.parse(command) }; } catch {}
    }

    const parsed: any = {};
    const actionMatch = command.match(/^([a-z_]+)/i);
    if (actionMatch) parsed.action = actionMatch[1].toLowerCase();

    const pairPattern = /([a-zA-Z][a-zA-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pairPattern.exec(command)) !== null) {
      parsed[match[1]] = match[2].replace(/^("|')|("|')$/g, '');
    }

    return { ...data, ...parsed };
  }

  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
  }

  private static getApiKey(): string {
    return (process.env.OPENAI_API_KEY || env.openaiApiKey || '').trim().replace(/^["']|["']$/g, '');
  }

  public static getSessionContext(senderId: string, storeSlug: string, storeId: number, channel: string = 'instagram'): SessionContext {
    this.validateStoreId(storeId);
    const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { storeId, history: [], cart: [], checkoutConfirmed: false, variantVerified: false });
    }
    const ctx = this.sessions.get(key)!;
    if (!ctx.cart) ctx.cart = [];
    if (typeof ctx.checkoutConfirmed !== 'boolean') ctx.checkoutConfirmed = false;
    if (typeof ctx.variantVerified !== 'boolean') ctx.variantVerified = false;
    ctx.storeId = storeId;
    return ctx;
  }

  /**
   * Kalıcı Sohbet Veritabanı ve Token Kullanım Takibi (ai_usage) - Multi-Tenant Scoped
   */
  public static getOrCreateConversation(storeId: number, externalUserId: string): number {
    this.validateStoreId(storeId);
    try {
      let conv = db.prepare('SELECT id FROM conversations WHERE store_id = ? AND external_user_id = ?').get(storeId, externalUserId) as any;
      if (!conv) {
        const res = db.prepare('INSERT INTO conversations (store_id, external_user_id) VALUES (?, ?)').run(storeId, externalUserId);
        return Number(res.lastInsertRowid);
      }
      return conv.id;
    } catch {
      return 1;
    }
  }

  public static persistMessage(conversationId: number, senderType: 'user' | 'assistant', text: string): void {
    try {
      db.prepare('INSERT INTO messages (conversation_id, sender_type, text) VALUES (?, ?, ?)').run(conversationId, senderType, text);
    } catch (error: any) {
      console.error(`[AI Conversation] Mesaj kaydedilemedi (conversation=${conversationId}, sender=${senderType}):`, error?.message || error);
    }
  }

  public static logAiUsage(storeId: number, conversationId: number, model: string, inputTokens: number, outputTokens: number, latency: number) {
    this.validateStoreId(storeId);
    try {
      const totalTokens = inputTokens + outputTokens;
      const isMini = model.includes('mini');
      const inputCost = (inputTokens / 1_000_000) * (isMini ? 0.15 : 2.50);
      const outputCost = (outputTokens / 1_000_000) * (isMini ? 0.60 : 10.00);
      const estimatedCost = (inputCost + outputCost) * 35.0;

      db.prepare(`
        INSERT INTO ai_usage (store_id, conversation_id, model, input_tokens, output_tokens, total_tokens, estimated_cost, latency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(storeId, conversationId, model, inputTokens, outputTokens, totalTokens, estimatedCost, latency);
    } catch (e: any) {
      console.warn('[AI Usage Tracker] Token logging error:', e.message);
    }
  }

  /**
   * Yapay Zeka Destekli Akıllı Veri Ayıklama Motoru (AI Extractor)
   */
  private static async extractSessionDataWithAI(senderId: string, userText: string, apiKey: string, storeSlug: string, storeId: number, channel: string) {
    const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);

    try {
      const extractorModel = new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: 'gpt-4o-mini',
        temperature: 0
      });

      const extractionPrompt = `
Müşterinin gönderdiği mesajdan ad-soyad, telefon, adres, ürün kodu, beden ve adet verilerini ayıkla.

KATI ÜRÜN KODU KURALI:
- Müşteri yalnız "HBL" yazdıysa productCode "HBL" olmalıdır; bunu HBL-M, HBL-S gibi bir varyanta dönüştürme.
- Beden yalnız açıkça söylendiyse size alanına yazılmalıdır.
- "HBL M" veya "HBL-M" açıkça yazıldıysa productCode "HBL", size "M" olarak ayrıştırılmalıdır.
- Ürün koduna beden ekleme; tam varyant kodunu backend ürün kodu + beden ile oluşturacaktır.

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

      const response = await extractorModel.invoke([new HumanMessage(extractionPrompt)]);
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
    } catch (e: any) {
      console.warn('[AI Extractor] ⚠️ AI veri ayıklama hatası:', e.message);
    }
  }

  /**
   * Mesajdaki kodu, AI tahmininden bağımsız olarak yalnızca bu mağazanın ürünleriyle eşleştirir.
   * Kısa kod (HBL) asla rastgele bir beden varyantına (HBL-M) dönüştürülmez.
   */
  private static hydrateProductCodeFromMessage(userText: string, storeId: number, ctx: SessionContext): void {
    const rawText = String(userText || '').trim();
    if (!rawText) return;

    const rows = db.prepare(`
      SELECT product_code, short_code
      FROM products
      WHERE store_id = ?
    `).all(storeId) as any[];
    const normalizedText = rawText.toUpperCase();
    const containsExactCode = (value: string) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}-])${escaped}($|[^\\p{L}\\p{N}-])`, 'iu').test(normalizedText);
    };

    // Tam kod yazıldıysa olduğu gibi koru. Aksi durumda yalnız kısa kodu sakla;
    // beden geldikten sonra ilgili tam varyant sorgulanır.
    const fullCodeMatch = rows.find(row => containsExactCode(String(row.product_code || '')));
    const shortCodeMatch = rows.find(row => containsExactCode(String(row.short_code || '')));
    const nextProductCode = fullCodeMatch?.product_code || shortCodeMatch?.short_code;
    if (nextProductCode) {
      const normalizedCode = String(nextProductCode).trim().toUpperCase();
      if (ctx.productCode !== normalizedCode) {
        ctx.productCode = normalizedCode;
        delete ctx.size;
        delete ctx.quantity;
        ctx.variantVerified = false;
      }
    }
  }

  /**
   * Kısa kodla başlayan sipariş akışını model yerine backend yönetir.
   * Böylece HBL gibi bir koddan HBL-M/HBL-S diye varsayım üretilemez.
   */
  private static getShortCodeOrderReply(storeId: number, ctx: SessionContext, userText: string): string | null {
    const shortCode = String(ctx.productCode || '').trim().toUpperCase();
    if (!shortCode || ctx.variantVerified) return null;

    const variants = db.prepare(`
      SELECT product_code, short_code, name, size, price, stock
      FROM products
      WHERE store_id = ? AND UPPER(short_code) = ?
      ORDER BY size ASC
    `).all(storeId, shortCode) as any[];

    // Tam ürün koduyla başlayan normal akışa müdahale etme.
    if (variants.length === 0 || !variants.some(row => String(row.product_code).toUpperCase() !== shortCode)) {
      return null;
    }

    const normalizedText = String(userText || '').toUpperCase();
    const containsExactValue = (value: string) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Unicode harf sınırı kullanılır. Böylece M bedeni "Müşteri" kelimesindeki
      // ilk M harfiyle yanlışlıkla eşleşmez; yalnız "M", "beden M" gibi bağımsız değerler kabul edilir.
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(normalizedText);
    };
    const selectedVariant = variants.find(row => containsExactValue(String(row.size || '').trim().toUpperCase()));
    if (!selectedVariant) {
      const sizes = [...new Set(variants.map(row => String(row.size).trim().toUpperCase()).filter(Boolean))];
      return `${shortCode} kodlu ürün için mevcut bedenler: ${sizes.join(', ')}. Hangi bedeni istersiniz?`;
    }

    const variant = selectedVariant;

    const price = Number(variant.price);
    if (!Number.isFinite(price) || price < 0) {
      return `${variant.product_code} için fiyat henüz tanımlı değil. Lütfen mağaza ile iletişime geçin.`;
    }

    ctx.productCode = String(variant.product_code).trim().toUpperCase();
    ctx.size = String(variant.size).trim().toUpperCase();
    ctx.variantVerified = true;
    if (Number(variant.stock) <= 0) {
      return `${variant.product_code} (${ctx.size}) şu an stokta yok. Başka bir beden tercih eder misiniz?`;
    }

    return `${shortCode} kodlu ürünün ${ctx.size} bedeni stokta mevcut. Fiyatı ${price.toLocaleString('tr-TR')} TL. Kaç adet istersiniz?`;
  }

  /**
   * Alt Düğüm Araçlarını Tanımlar (Strict Store Isolation)
   */
  private static createLeafTools(senderId: string, storeSlug: string, storeId: number, channel: string) {
    const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);

    // STOK Tool
    const stokTool = new DynamicTool({
      name: 'STOK',
      description: 'Ürün kodu ve BEDEN bilgisi mevcutsa doğru varyantın stok ve fiyatını kontrol eder.',
      func: async (input: string) => {
        try {
          let request: any = {};
          try { request = typeof input === 'object' ? input : JSON.parse(input); } catch { request = { productCode: input }; }
          const query = String(request.productCode || request.query || ctx.productCode || '').trim();
          const requestedSize = String(request.size || ctx.size || '').trim().toUpperCase();

          // Fiyat yalnızca ürünün tam varyantı (ürün kodu + beden) doğrulandığında verilir.
          // Böylece farklı beden/varyantın fiyatı müşteriye gösterilmez.
          if (query && requestedSize) {
            const product = db.prepare(`
              SELECT product_code, short_code, name, size, price, stock
              FROM products
              WHERE store_id = ?
                AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
                AND UPPER(size) = ?
              LIMIT 1
            `).get(storeId, query.toUpperCase(), query.toUpperCase(), requestedSize) as any;

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

          const result = await StockService.checkStock(storeId, query);
          if (!result.exists) return JSON.stringify({ exists: false, message: 'Ürün bulunamadı.' });
          
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
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
    });

    // SEPETE_EKLE Tool (Store Isolated)
    const sepeteEkleTool = new DynamicTool({
      name: 'SEPETE_EKLE',
      description: 'Müşterinin istediği ürünü, bedenini ve adetini sepete ekler.',
      func: async (input: string) => {
        try {
          let data: any = {};
          try { data = typeof input === 'object' ? input : JSON.parse(input); } catch { data = {}; }

          const pCode = String(data.productCode || '').trim().toUpperCase();
          const pSize = String(data.size || '').trim().toUpperCase();
          const pQty = Number(data.quantity);
          if (!pCode || !pSize || !Number.isInteger(pQty) || pQty <= 0) {
            return JSON.stringify({ success: false, message: 'Sepete eklemek için ürün kodu, beden ve adet zorunludur.' });
          }

          const pCodeUpper = pCode.toUpperCase();
          const prod = db.prepare(`
            SELECT * FROM products 
            WHERE store_id = ?
              AND (UPPER(product_code) = ? OR UPPER(short_code) = ?)
              AND UPPER(size) = ?
            LIMIT 1
          `).get(storeId, pCodeUpper, pCodeUpper, pSize) as any;
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
          } else {
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
          const shippingSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId) as any;
          const thresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId) as any;
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
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
    });

    const sepetOnaylaTool = new DynamicTool({
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
    const sepetGoruntuleTool = new DynamicTool({
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
    const kayitTool = new DynamicTool({
      name: 'KAYIT',
      description: 'Müşterinin 3 Bilgisi (İsim, Tel, Adres) Tamamlandıysa Toplu Siparişi Oluşturur.',
      func: async (input: string) => {
        try {
          let data: any = {};
          try { data = typeof input === 'object' ? input : JSON.parse(input); } catch { data = {}; }

          const customerName = data.customerName || ctx.customerName;
          const customerPhone = data.customerPhone || ctx.customerPhone;
          const address = data.address || ctx.address;

          if (!ctx.cart || ctx.cart.length === 0) {
            return JSON.stringify({ success: false, orderCreated: false, message: 'Sipariş oluşturmak için önce ürün kodu, beden ve adet ile sepet oluşturulmalıdır.' });
          }

          if (!ctx.checkoutConfirmed) {
            return JSON.stringify({ success: false, orderCreated: false, message: 'Sipariş oluşturulmadan önce sepet özeti müşteriye gösterilmeli ve müşterinin açık onayı alınmalıdır.' });
          }

          const missingFields: string[] = [];
          if (!customerName || customerName.trim().length <= 1) missingFields.push('İsim Soyisim');
          if (!customerPhone || customerPhone.replace(/\D/g, '').length < 10) missingFields.push('Telefon Numarası');
          if (!address || address.trim().length < 10) missingFields.push('Açık Teslimat Adresi');

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
          const shippingSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId) as any;
          const thresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId) as any;
          const loyaltyThresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'loyalty_threshold'").get(storeId) as any;
          
          let shippingFee = Number(shippingSetting?.value || 49);
          const freeThreshold = Number(thresholdSetting?.value || 1500);
          const loyaltyThreshold = Number(loyaltyThresholdSetting?.value || 2000);

          if (subtotal >= freeThreshold) {
            shippingFee = 0;
          }

          let discount = 0;
          let appliedLoyaltyReward = false;

          // Müşterinin Instagram ID'sine tanımlı mağaza bazlı VIP Ödülü
          const userReward = db.prepare('SELECT * FROM user_rewards WHERE store_id = ? AND sender_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1').get(storeId, senderId) as any;
          
          if (userReward) {
            discount = (subtotal * (userReward.discount_percent / 100));
            appliedLoyaltyReward = true;
            db.prepare('UPDATE user_rewards SET is_used = 1, used_at = CURRENT_TIMESTAMP WHERE store_id = ? AND id = ?').run(storeId, userReward.id);
          } else {
            const activeCampaigns = db.prepare('SELECT * FROM campaigns WHERE store_id = ? AND active = 1').all(storeId) as any[];
            for (const c of activeCampaigns) {
              if (c.code === 'BARONS10') {
                discount += (subtotal * 0.10);
              }
            }
          }

          const totalPrice = Math.max(0, subtotal + shippingFee - discount);

          let earnedNewLoyaltyReward = false;
          const autoVipSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'auto_vip_reward_enabled'").get(storeId) as any;
          const isAutoVipEnabled = autoVipSetting && (autoVipSetting.value === '1' || autoVipSetting.value === 'true');

          if (isAutoVipEnabled && subtotal >= loyaltyThreshold) {
            const rewardCode = 'YINEBEKLERIZ';
            db.prepare(`
              INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount)
              VALUES (?, ?, ?, 20.0, ?)
            `).run(storeId, senderId, rewardCode, loyaltyThreshold);
            earnedNewLoyaltyReward = true;

            const autoDmText = `🎉 TEBRİKLER / VIP ÖDÜL KAZANDINIZ!\nSayın ${customerName.trim()}, profilinize özel %20 VIP İNDİRİM tanımlanmıştır! (Ödül Kodu: ${rewardCode})\nKeyifli alışverişler dileriz! 🎁✨`;
            const autoRewardNotificationSent = await FacebookService.sendMessage(senderId, autoDmText, storeId);
            if (!autoRewardNotificationSent) {
              console.warn(`[Auto Reward DM] VIP ödülü tanımlandı ancak Instagram DM gönderilemedi (Store: ${storeId}, Sender: ${senderId}, Code: ${rewardCode}).`);
            }
          }

          const primaryItem = ctx.cart[0];
          if (ctx.cart.length !== 1) {
            return JSON.stringify({
              success: false,
              orderCreated: false,
              message: 'Sipariş kaydı şu anda her seferinde tek ürün varyantı için oluşturulabilir. Lütfen ürünleri ayrı siparişler olarak tamamlayın.'
            });
          }

          const order = await OrderService.createOrder(storeId, {
            storeId: storeId,
            customerName: customerName,
            customerPhone: customerPhone,
            address: address,
            productCode: primaryItem.productCode,
            productName: primaryItem.productName,
            size: primaryItem.size,
            quantity: primaryItem.quantity,
            unitPrice: primaryItem.unitPrice,
            senderId: senderId
          });

          db.prepare(`
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
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
    });

    // MESAJ Tool
    const mesajTool = new DynamicTool({
      name: 'MESAJ',
      description: 'İşletme sahibine Telegram üzerinden HTML bildirim yollar.',
      func: async (input: string) => {
        try {
          let data: any = typeof input === 'object' ? input : JSON.parse(input);
          await TelegramService.notifyOrder(storeId, {
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
        } catch (e: any) {
          return `Telegram hatası: ${e.message}`;
        }
      }
    });

    // GUNCELLE Tool
    const guncelleTool = new DynamicTool({
      name: 'GUNCELLE',
      description: 'Sipariş onaylandığında stok miktarını günceller.',
      func: async (input: string) => {
        try {
          let data: any = typeof input === 'object' ? input : JSON.parse(input);
          const pCode = data.productCode || ctx.productCode;
          if (pCode) {
            await StockService.deductStock(storeId, pCode, Number(data.quantity) || 1);
          }
          return 'Stok başarıyla güncellendi.';
        } catch (e: any) {
          return `Stok güncelleme hatası: ${e.message}`;
        }
      }
    });

    return { stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, mesajTool, guncelleTool };
  }

  private static createBilgilendirmeSubAgent(model: ChatOpenAI, mesajTool: DynamicTool) {
    return new DynamicTool({
      name: 'BILGILENDIRME',
      description: 'Sipariş oluşturulduğunda Telegram bildirimi gönderir.',
      func: async (input: string) => {
        return await mesajTool.invoke(input);
      }
    });
  }

  private static createSiparisSubAgent(model: ChatOpenAI, stokTool: DynamicTool, sepeteEkleTool: DynamicTool, sepetGoruntuleTool: DynamicTool, sepetOnaylaTool: DynamicTool, kayitTool: DynamicTool, bilgilendirmeTool: DynamicTool) {
    return new DynamicTool({
      name: 'SIPARIS',
      description: 'Sipariş akışını yürütür. action yalnızca stok, sepete_ekle, sepet_goruntule, sepet_onayla veya kayit olabilir. sepete_ekle için productCode, size ve quantity zorunludur. sepet_onayla yalnız müşteri açıkça sepeti onayladığında, kayit yalnız onay sonrası tam müşteri bilgileri varken kullanılır.',
      func: async (input: string) => {
        try {
          const data = this.normalizeSiparisToolInput(input);
          const action = data.action || 'stok';
          if (action === 'sepete_ekle') {
            return await sepeteEkleTool.invoke(JSON.stringify(data));
          } else if (action === 'sepet_goruntule') {
            return await sepetGoruntuleTool.invoke('');
          } else if (action === 'sepet_onayla') {
            return await sepetOnaylaTool.invoke('');
          } else if (action === 'kayit') {
            const res = await kayitTool.invoke(JSON.stringify(data));
            if (res.includes('"orderCreated":true')) {
              await bilgilendirmeTool.invoke(JSON.stringify(data));
            }
            return res;
          } else {
            return await stokTool.invoke(JSON.stringify(data));
          }
        } catch (e: any) {
          return JSON.stringify({ error: e.message });
        }
      }
    });
  }

  private static createStokManSubAgent(model: ChatOpenAI, guncelleTool: DynamicTool) {
    return new DynamicTool({
      name: 'STOK_MAN',
      description: 'Stok miktarını eksiltir.',
      func: async (input: string) => {
        return await guncelleTool.invoke(input);
      }
    });
  }

  /**
   * Mesaj İşleme Ana Metodu (Strict Store Isolation & Security)
   */
  public static async processMessage(
    senderId: string, 
    userMessage: string, 
    storeSlug: string,
    storeId: number,
    channel: string = 'instagram'
  ): Promise<{
    reply: string;
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
    toolTraces: ToolTraceItem[];
    cart: CartItem[];
  }> {
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
    const toolTraces: ToolTraceItem[] = [];

    const trackUsage = (res: any, currentMessagesCount: number) => {
      if (res?.usage_metadata) {
        promptTokens += res.usage_metadata.input_tokens || 0;
        completionTokens += res.usage_metadata.output_tokens || 0;
      } else {
        promptTokens += Math.ceil(currentMessagesCount * 120);
        completionTokens += Math.ceil((typeof res?.content === 'string' ? res.content.length : 100) / 4);
      }
    };

    try {
      await this.extractSessionDataWithAI(senderId, userMessage, apiKey, storeSlug, storeId, channel);
      const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
      this.hydrateProductCodeFromMessage(userMessage, storeId, ctx);

      const deterministicOrderReply = this.getShortCodeOrderReply(storeId, ctx, userMessage);
      if (deterministicOrderReply) {
        ctx.history.push(new HumanMessage(userMessage), new AIMessage(deterministicOrderReply));
        if (ctx.history.length > 16) {
          ctx.history.splice(0, ctx.history.length - 16);
        }
        return {
          reply: deterministicOrderReply,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
          toolTraces: [],
          cart: ctx.cart
        };
      }

      // Veritabanından Aktif Kampanyaları Çek (Store Isolated)
      const activeCampaigns = db.prepare(`
        SELECT title, description, code, start_date, end_date 
        FROM campaigns 
        WHERE store_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '' OR end_date >= DATE('now'))
      `).all(storeId) as any[];

      const shippingSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId) as any;
      const thresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId) as any;
      const loyaltyThresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'loyalty_threshold'").get(storeId) as any;
      
      const userReward = db.prepare("SELECT * FROM user_rewards WHERE store_id = ? AND sender_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1").get(storeId, senderId) as any;

      const shippingFee = shippingSetting?.value || '49';
      const freeThreshold = thresholdSetting?.value || '1500';
      const loyaltyThreshold = loyaltyThresholdSetting?.value || '2000';

      let rewardText = "";
      if (userReward) {
        rewardText = `🎁 **MÜŞTERİNİN İNSTAGRAM HESABINA TANIMLI ÖZEL ÖDÜL:** Müşterinin hesabına tanımlı %${userReward.discount_percent} VIP İNDİRİM HAKKI vardır! Bu siparişinde müşteri özel %${userReward.discount_percent} VIP indirimi kazanır.`;
      } else {
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

      const model = new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: env.openaiModel || 'gpt-4o',
        temperature: 0.2
      });

      const { stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, mesajTool, guncelleTool } = this.createLeafTools(senderId, storeSlug, storeId, channel);
      const bilgilendirmeAgentTool = this.createBilgilendirmeSubAgent(model, mesajTool);
      const siparisAgentTool = this.createSiparisSubAgent(model, stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, bilgilendirmeAgentTool);
      const stokManAgentTool = this.createStokManSubAgent(model, guncelleTool);

      const rootTools = [siparisAgentTool, stokManAgentTool];
      const boundRootModel = model.bindTools(rootTools);

      const systemPrompt = new SystemMessage(`
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

      ctx.history.push(new HumanMessage(userMessage));
      if (ctx.history.length > 16) {
        ctx.history.splice(0, ctx.history.length - 16);
      }

      let messages: BaseMessage[] = [systemPrompt, ...ctx.history];
      let response = await boundRootModel.invoke(messages);
      trackUsage(response, messages.length);
      messages.push(response);

      let count = 0;
      while (response.tool_calls && response.tool_calls.length > 0 && count < 4) {
        count++;
        for (const tc of response.tool_calls) {
          const startTime = Date.now();
          let toolResult = "";
          let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
          try {
            if (tc.name === 'SIPARIS') {
              toolResult = await siparisAgentTool.invoke(JSON.stringify(tc.args));
            } else if (tc.name === 'STOK_MAN') {
              toolResult = await stokManAgentTool.invoke(JSON.stringify(tc.args));
            } else {
              toolResult = "Bilinmeyen araç";
            }
          } catch (err: any) {
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
          messages.push(new ToolMessage({ content: toolResult, tool_call_id: tc.id! }));
        }
        response = await boundRootModel.invoke(messages);
        trackUsage(response, messages.length);
        messages.push(response);
      }

      const finalOutput = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      ctx.history.push(new AIMessage(finalOutput));

      const totalTokens = promptTokens + completionTokens;
      const costUsd = (promptTokens * 0.0000025) + (completionTokens * 0.00001);

      return {
        reply: finalOutput,
        tokens: { promptTokens, completionTokens, totalTokens, costUsd },
        toolTraces,
        cart: ctx.cart
      };

    } catch (error: any) {
      console.error('[AIService] ❌ İşlem Hatası:', error);
      return {
        reply: "Üzgünüm, şu an bağlantıda geçici bir yoğunluk var. Lütfen biraz sonra tekrar deneyiniz.",
        tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
        toolTraces: [],
        cart: []
      };
    }
  }

  public static resetTestSession(storeId: number, storeSlug: string, senderId: string, channel: string = 'TEST', action: 'cart' | 'conversation' | 'all' = 'all') {
    const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
    if (this.sessions.has(key)) {
      const ctx = this.sessions.get(key)!;
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

  public static getSessionInfo(storeId: number, storeSlug: string, senderId: string, channel: string = 'TEST') {
    const key = `${storeId}:${storeSlug}:${channel}:${senderId}`;
    const ctx = this.sessions.get(key) || { storeId, history: [], cart: [] };
    return {
      cart: ctx.cart || [],
      historyCount: ctx.history ? ctx.history.length : 0
    };
  }
}
