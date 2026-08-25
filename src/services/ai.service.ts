import { ChatOpenAI } from '@langchain/openai';
import { DynamicTool } from '@langchain/core/tools';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { AIProviderService } from './ai-provider.service';
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
  currentTurnContactFields?: Array<'customerName' | 'customerPhone' | 'address'>;
}

/**
 * Multi-Tenant n8n LangChain AI Service (Strict Store Isolation & Security)
 */
export class AIService {
  private static sessions: Map<string, SessionContext> = new Map();

  private static getActiveCampaigns(storeId: number, subtotal?: number): any[] {
    const rows = db.prepare(`
      SELECT id, title, description, code, discount_percent, discount_amount, min_order_amount, start_date, end_date
      FROM campaigns
      WHERE store_id = ? AND active = 1
        AND (start_date IS NULL OR start_date = '' OR start_date <= DATE('now'))
        AND (end_date IS NULL OR end_date = '' OR end_date >= DATE('now'))
      ORDER BY id DESC
    `).all(storeId) as any[];
    if (subtotal === undefined) return rows;
    return rows.filter(campaign => Number(campaign.min_order_amount || 0) <= subtotal);
  }

  private static getBestCampaignDiscount(storeId: number, subtotal: number): { campaign: any; discount: number } | null {
    const choices = this.getActiveCampaigns(storeId, subtotal).map(campaign => {
      const percent = Math.min(100, Math.max(0, Number(campaign.discount_percent) || 0));
      const amount = Math.max(0, Number(campaign.discount_amount) || 0);
      const discount = Math.min(subtotal, (subtotal * percent / 100) + amount);
      return { campaign, discount };
    }).filter(choice => choice.discount > 0);
    return choices.sort((a, b) => b.discount - a.discount || Number(b.campaign.id) - Number(a.campaign.id))[0] || null;
  }

  private static getEligibleVipReward(storeId: number, senderId: string, subtotal: number): any | null {
    const rewards = db.prepare(`
      SELECT * FROM user_rewards
      WHERE store_id = ? AND sender_id = ? AND is_used = 0
      ORDER BY id DESC
    `).all(storeId, senderId) as any[];
    return rewards.find(reward => Number(reward.min_qualifying_amount || 0) <= subtotal) || null;
  }

  private static getOrderPromotion(storeId: number, senderId: string, subtotal: number): {
    discount: number;
    vipReward: any | null;
    campaign: any | null;
    label: string;
  } {
    const vipReward = this.getEligibleVipReward(storeId, senderId, subtotal);
    if (vipReward) {
      const percent = Math.min(100, Math.max(0, Number(vipReward.discount_percent) || 0));
      return {
        discount: Math.min(subtotal, subtotal * percent / 100),
        vipReward,
        campaign: null,
        label: `%${percent} VIP indirimi`
      };
    }
    const campaignChoice = this.getBestCampaignDiscount(storeId, subtotal);
    return {
      discount: campaignChoice?.discount || 0,
      vipReward: null,
      campaign: campaignChoice?.campaign || null,
      label: campaignChoice ? String(campaignChoice.campaign.title || campaignChoice.campaign.code || 'Kampanya') : ''
    };
  }

  private static getStorePersona(storeId: number): { storeName: string; tone: string; toneInstruction: string; customPrompt: string } {
    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('bot_tone', 'bot_system_prompt')
    `).all(storeId) as any[];
    const settings = Object.fromEntries(rows.map(row => [String(row.key), String(row.value || '')]));
    const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId) as any;
    const storeName = String(store?.name || 'Mağazamız').trim().slice(0, 80) || 'Mağazamız';
    const tone = ['luxury', 'friendly', 'formal', 'patron'].includes(settings.bot_tone)
      ? settings.bot_tone
      : 'luxury';
    const toneInstructions: Record<string, string> = {
      luxury: 'Zarif, premium, saygılı ve güven veren bir üslup kullan. Gereksiz samimiyetten ve aşırı emojiden kaçın.',
      friendly: 'Samimi, sıcak ve yardımsever konuş. Kısa, doğal cümleler ve ölçülü emoji kullan.',
      formal: 'Kurumsal, kısa ve profesyonel konuş. Emoji kullanma; net ve doğrudan yanıt ver.',
      patron: 'Kendinden emin, çözüm odaklı ve hızlı bir yönetici asistanı üslubu kullan; müşteriye daima saygılı ol.'
    };

    return {
      storeName,
      tone,
      toneInstruction: toneInstructions[tone],
      customPrompt: String(settings.bot_system_prompt || '').trim().slice(0, 4000)
    };
  }

  private static extractLabeledContactData(text: string): Partial<SessionContext> {
    const value = String(text || '');
    const customerName = value.match(/(?:^|[,;\n])\s*(?:ad(?:\s*soyad)?|isim(?:\s*soyisim)?)\s*[:=]\s*([^,;\n]+)/iu)?.[1]?.trim();
    const customerPhone = value.match(/(?:^|[,;\n])\s*(?:telefon|tel|cep)\s*[:=]\s*([+\d][\d\s().-]{8,})/iu)?.[1]?.trim();
    const address = value.match(/(?:^|[,;\n])\s*(?:açık\s+teslimat\s+adresi|adres)\s*[:=]\s*(.+)$/iu)?.[1]?.trim();
    return {
      ...(customerName ? { customerName } : {}),
      ...(customerPhone ? { customerPhone } : {}),
      ...(address ? { address } : {})
    };
  }

  /**
   * LangChain DynamicTool argümanlarını JSON, düz komut, virgüllü anahtar/değer
   * veya etiketli müşteri bilgisi biçimlerinden tek SIPARIS komutuna dönüştürür.
   */
  private static normalizeSiparisToolInput(input: any): any {
    let data: any = input;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = { input: data }; }
    }
    if (!data || typeof data !== 'object') data = {};

    const command = typeof data.input === 'string' ? data.input.trim() : '';
    let parsed: any = {};
    if (command.startsWith('{')) {
      try { parsed = JSON.parse(command); } catch {}
    } else if (command) {
      const explicitAction = command.match(/(?:^|[,\s])action\s*=\s*(stok|sepete_ekle|sepet_goruntule|sepet_onayla|kayit)\b/i)?.[1];
      const leadingAction = command.match(/^\s*(stok|sepete_ekle|sepet_goruntule|sepet_onayla|kayit)\b/i)?.[1];
      if (explicitAction || leadingAction) parsed.action = String(explicitAction || leadingAction).toLowerCase();

      const pairPattern = /([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^,\s]+)/g;
      let match: RegExpExecArray | null;
      while ((match = pairPattern.exec(command)) !== null) {
        parsed[match[1]] = match[2].replace(/^("|')|("|')$/g, '').replace(/[,;]+$/g, '');
      }
      Object.assign(parsed, this.extractLabeledContactData(command));

      if ((parsed.action || '').toLowerCase() === 'stok' && !parsed.productCode) {
        const positional = command
          .split(/[\s,]+/)
          .map((part: string) => part.trim())
          .filter(Boolean)
          .filter((part: string) => !/^(?:action=)?stok$/i.test(part));
        if (positional[0] && !positional[0].includes('=')) parsed.productCode = positional[0];
        if (positional[1] && !positional[1].includes('=')) parsed.size = positional[1];
      }
    }

    const normalized: any = { ...data, ...parsed };
    normalized.customerName = normalized.customerName || normalized.adSoyad || normalized.ad_soyad || normalized.ad;
    normalized.customerPhone = normalized.customerPhone || normalized.telefon || normalized.phone;
    normalized.address = normalized.address || normalized.adres;
    if (normalized.action) normalized.action = String(normalized.action).toLowerCase().replace(/[^a-z_].*$/i, '');
    if (normalized.productCode) normalized.productCode = String(normalized.productCode).replace(/[,;]+$/g, '').trim();
    if (normalized.size) normalized.size = String(normalized.size).replace(/[,;]+$/g, '').trim();
    if (!normalized.action && (normalized.customerName || normalized.customerPhone || normalized.address)) {
      normalized.action = 'kayit';
    }
    return normalized;
  }

  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
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
  private static async extractSessionDataWithAI(senderId: string, userText: string, storeSlug: string, storeId: number, channel: string) {
    const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
    const labeledContact = this.extractLabeledContactData(userText);
    if (labeledContact.customerName) {
      ctx.customerName = labeledContact.customerName;
      if (!ctx.currentTurnContactFields?.includes('customerName')) ctx.currentTurnContactFields?.push('customerName');
    }
    if (labeledContact.customerPhone) {
      ctx.customerPhone = labeledContact.customerPhone;
      if (!ctx.currentTurnContactFields?.includes('customerPhone')) ctx.currentTurnContactFields?.push('customerPhone');
    }
    if (labeledContact.address) {
      ctx.address = labeledContact.address;
      if (!ctx.currentTurnContactFields?.includes('address')) ctx.currentTurnContactFields?.push('address');
    }

    try {
      const extractorModel = AIProviderService.createChatModel(storeId, { temperature: 0 });

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
          if (!ctx.currentTurnContactFields?.includes('customerName')) ctx.currentTurnContactFields?.push('customerName');
        }
        if (data.customerPhone && data.customerPhone !== 'null') {
          ctx.customerPhone = data.customerPhone.trim();
          if (!ctx.currentTurnContactFields?.includes('customerPhone')) ctx.currentTurnContactFields?.push('customerPhone');
        }
        if (data.address && data.address !== 'null' && data.address.trim().length > 3) {
          ctx.address = data.address.trim();
          if (!ctx.currentTurnContactFields?.includes('address')) ctx.currentTurnContactFields?.push('address');
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
    const containsExactCode = (value: string) => StockService.containsLookupValue(rawText, value);

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

    const variants = (db.prepare(`
      SELECT product_code, short_code, name, size, price, stock
      FROM products WHERE store_id = ? ORDER BY size ASC
    `).all(storeId) as any[]).filter(row => StockService.normalizeLookupValue(row.short_code) === StockService.normalizeLookupValue(shortCode));

    // Tam ürün koduyla başlayan normal akışa müdahale etme.
    if (variants.length === 0 || !variants.some(row => StockService.normalizeLookupValue(row.product_code) !== StockService.normalizeLookupValue(shortCode))) {
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
      const availableSizes = [...new Set(variants.filter(row => Number(row.stock) > 0).map(row => String(row.size).trim().toUpperCase()).filter(Boolean))];
      const unavailableSizes = [...new Set(variants.filter(row => Number(row.stock) <= 0).map(row => String(row.size).trim().toUpperCase()).filter(Boolean))];
      if (!availableSizes.length) return `${shortCode} kodlu ürünün tüm bedenleri şu an tükenmiş görünüyor.`;
      return `${shortCode} kodlu ürün için stokta bulunan bedenler: ${availableSizes.join(', ')}${unavailableSizes.length ? `. Tükenen bedenler: ${unavailableSizes.join(', ')}` : ''}. Hangi bedeni istersiniz?`;
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

  /** Returns stock availability without exposing inventory quantities to the customer. */
  private static async getProductStockReply(storeId: number, ctx: SessionContext, userText: string): Promise<string | null> {
    const text = String(userText || '');
    if (!/(?:stok|mevcut|kaldı|tükendi|var\s*m[ıi]|bulunuyor)/iu.test(text)) return null;
    const code = String(ctx.productCode || '').trim();
    if (!code) return null;

    const directVariant = StockService.findProductVariant(storeId, code, ctx.size);
    const isExactVariant = directVariant && (
      Boolean(ctx.size) ||
      StockService.normalizeLookupValue(directVariant.productCode) === StockService.normalizeLookupValue(code)
    );
    if (directVariant && isExactVariant) {
      const stock = Number(directVariant.stock) || 0;
      const quantity = Number(ctx.quantity) || 0;
      ctx.productCode = directVariant.productCode;
      ctx.size = directVariant.size;
      ctx.variantVerified = true;
      if (stock <= 0) return `${directVariant.name} (${directVariant.productCode}, ${directVariant.size}) şu an stokta yok.`;
      if (quantity > stock) return `${directVariant.name} (${directVariant.productCode}, ${directVariant.size}) için istediğiniz adet kadar yeterli stok bulunmuyor.`;
      return `${directVariant.name} (${directVariant.productCode}, ${directVariant.size}) stokta mevcut. Fiyatı ${Number(directVariant.price).toLocaleString('tr-TR')} TL.`;
    }

    const result = await StockService.checkStock(storeId, code);
    if (!result.exists) return `${code.toLocaleUpperCase('tr-TR')} kodlu ürün mağaza stoklarında bulunamadı.`;
    const variants = Array.isArray(result.product?.variants) ? result.product.variants : [];
    if (variants.length) {
      const availableSizes = variants
        .filter((variant: any) => Number(variant.stock) > 0)
        .map((variant: any) => String(variant.size || variant.productCode).toLocaleUpperCase('tr-TR'));
      const unavailableSizes = variants
        .filter((variant: any) => Number(variant.stock) <= 0)
        .map((variant: any) => String(variant.size || variant.productCode).toLocaleUpperCase('tr-TR'));
      const details: string[] = [];
      if (availableSizes.length > 0) details.push(`Stokta bulunan bedenler: ${availableSizes.join(', ')}`);
      if (unavailableSizes.length > 0) details.push(`Stokta olmayan bedenler: ${unavailableSizes.join(', ')}`);
      return `${result.product.name} (${result.product.productCode}) için ${details.join('. ')}.`;
    }
    const stock = Number(result.product?.stock) || 0;
    return stock > 0
      ? `${result.product?.name || code} stokta mevcut.`
      : `${result.product?.name || code} şu an stokta yok.`;
  }

  /** Answers informational price questions directly without forcing the customer into the order/size flow. */
  private static getProductPriceReply(storeId: number, ctx: SessionContext, userText: string): string | null {
    const text = String(userText || '');
    if (!/(?:fiyat|ne\s*kadar|kaça|kaç\s*(?:tl|lira)|ücret|tutar)/iu.test(text)) return null;
    const code = String(ctx.productCode || '').trim().toUpperCase();
    if (!code) return null;

    const rows = (db.prepare(`
      SELECT product_code, short_code, name, size, price, stock
      FROM products WHERE store_id = ? ORDER BY size ASC
    `).all(storeId) as any[]).filter(row => {
      const target = StockService.normalizeLookupValue(code);
      return StockService.normalizeLookupValue(row.product_code) === target || StockService.normalizeLookupValue(row.short_code) === target;
    });
    if (!rows.length) return null;

    const formatPrice = (value: number) => `${value.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} TL`;
    const validRows = rows.filter(row => Number.isFinite(Number(row.price)) && Number(row.price) >= 0);
    if (!validRows.length) return `${code} kodlu ürün için fiyat henüz tanımlı değil. Lütfen mağaza ile iletişime geçin.`;

    const exactVariant = validRows.find(row => StockService.normalizeLookupValue(row.product_code) === StockService.normalizeLookupValue(code));
    if (exactVariant) {
      return `${exactVariant.name} (${exactVariant.product_code}) ürününün fiyatı ${formatPrice(Number(exactVariant.price))}.`;
    }

    const normalizedText = text.toUpperCase();
    const selectedBySize = validRows.find(row => {
      const size = String(row.size || '').trim().toUpperCase();
      if (!size) return false;
      const escaped = size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(normalizedText);
    });
    if (selectedBySize) {
      return `${selectedBySize.name} ürününün ${selectedBySize.size} beden fiyatı ${formatPrice(Number(selectedBySize.price))}.`;
    }

    const uniquePrices = [...new Set(validRows.map(row => Number(row.price)))];
    if (uniquePrices.length === 1) {
      return `${validRows[0].name} (${code}) ürününün fiyatı ${formatPrice(uniquePrices[0])}.`;
    }

    const variantPrices = validRows.map(row => `${String(row.size || row.product_code).toUpperCase()}: ${formatPrice(Number(row.price))}`);
    return `${validRows[0].name} (${code}) için bedenlere göre fiyatlar: ${variantPrices.join(', ')}.`;
  }

  /**
   * Alt Düğüm Araçlarını Tanımlar (Strict Store Isolation)
   */
  private static createLeafTools(senderId: string, storeSlug: string, storeId: number, channel: string) {
    const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);

    // STOK Tool
    const stokTool = new DynamicTool({
      name: 'STOK',
      description: 'Ürün kodu ve BEDEN bilgisi mevcutsa doğru varyantın stokta olup olmadığını ve fiyatını kontrol eder. Stok adedi müşteriye açıklanmaz.',
      func: async (input: string) => {
        try {
          let request: any = {};
          try { request = typeof input === 'object' ? input : JSON.parse(input); } catch { request = { productCode: input }; }
          const query = String(request.productCode || request.query || ctx.productCode || '').trim();
          const requestedSize = String(request.size || ctx.size || '').trim().toUpperCase();

          // Fiyat yalnızca ürünün tam varyantı (ürün kodu + beden) doğrulandığında verilir.
          // Böylece farklı beden/varyantın fiyatı müşteriye gösterilmez.
          if (query && requestedSize) {
            const resolvedProduct = StockService.findProductVariant(storeId, query, requestedSize);
            const product = resolvedProduct ? {
              product_code: resolvedProduct.productCode,
              short_code: resolvedProduct.shortCode,
              name: resolvedProduct.name,
              size: resolvedProduct.size,
              price: resolvedProduct.price,
              stock: resolvedProduct.stock
            } : null;

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
            price: result.product?.price,
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

          const pCode = StockService.normalizeLookupValue(data.productCode);
          const pSize = StockService.normalizeLookupValue(data.size);
          const pQty = Number(data.quantity);
          if (!pCode || !pSize || !Number.isInteger(pQty) || pQty <= 0) {
            return JSON.stringify({ success: false, message: 'Sepete eklemek için ürün kodu, beden ve adet zorunludur.' });
          }

          const resolvedProduct = StockService.findProductVariant(storeId, pCode, pSize);
          const prod = resolvedProduct ? {
            product_code: resolvedProduct.productCode,
            short_code: resolvedProduct.shortCode,
            name: resolvedProduct.name,
            size: resolvedProduct.size,
            price: resolvedProduct.price,
            stock: resolvedProduct.stock
          } : null;
          if (!prod) {
            return JSON.stringify({ success: false, message: `${pCode} kodlu ${pSize} beden ürünü bulunamadı.` });
          }
          const unitPrice = Number(prod.price);
          const productName = prod.name;

          if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            return JSON.stringify({ success: false, message: `${productName} için geçerli bir fiyat tanımlı değil. Siparişe eklenemedi.` });
          }

          if (Number(prod.stock) < pQty) {
            return JSON.stringify({ success: false, message: `${productName} (${pSize}) için istenen adet kadar yeterli stok bulunmadığından sepete eklenemedi.` });
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
          const promotion = this.getOrderPromotion(storeId, senderId, cartSubtotal);
          const totalEstimate = Math.max(0, cartSubtotal + shippingFeeEstimate - promotion.discount);

          return JSON.stringify({
            success: true,
            message: `${productName} (Beden: ${pSize}, Adet: ${pQty}) sepete eklendi!`,
            cartItemCount: ctx.cart.length,
            cartTotalItems: ctx.cart.reduce((sum, i) => sum + i.quantity, 0),
            cartSubtotal: cartSubtotal,
            shippingFeeEstimate: shippingFeeEstimate,
            discountEstimate: promotion.discount,
            promotionLabel: promotion.label,
            totalEstimate: totalEstimate,
            priceMessage: `Ara Toplam: ${cartSubtotal.toFixed(2)} TL | Kargo: ${shippingFeeEstimate === 0 ? 'ÜCRETSİZ' : shippingFeeEstimate + ' TL'}${promotion.discount > 0 ? ` | ${promotion.label}: -${promotion.discount.toFixed(2)} TL` : ''} | Tahmini Toplam: ${totalEstimate.toFixed(2)} TL`,
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
        const wasAlreadyConfirmed = ctx.checkoutConfirmed;
        ctx.checkoutConfirmed = true;
        // On the first confirmation, discard personal data sent in older, unconfirmed turns.
        // Later confirmation calls must retain fields collected across separate messages.
        if (!wasAlreadyConfirmed) {
          const suppliedNow = new Set(ctx.currentTurnContactFields || []);
          const currentValues = {
            customerName: ctx.customerName,
            customerPhone: ctx.customerPhone,
            address: ctx.address
          };
          delete ctx.customerName;
          delete ctx.customerPhone;
          delete ctx.address;
          if (suppliedNow.has('customerName')) ctx.customerName = currentValues.customerName;
          if (suppliedNow.has('customerPhone')) ctx.customerPhone = currentValues.customerPhone;
          if (suppliedNow.has('address')) ctx.address = currentValues.address;
        }
        const missingFields: string[] = [];
        if (!ctx.customerName || ctx.customerName.trim().length <= 1) missingFields.push('ad soyad');
        if (!ctx.customerPhone || ctx.customerPhone.replace(/\D/g, '').length < 10) missingFields.push('telefon numarası');
        if (!ctx.address || ctx.address.trim().length < 10) missingFields.push('açık teslimat adresi');
        const readyToCreateOrder = missingFields.length === 0;
        return JSON.stringify({
          success: true,
          checkoutConfirmed: true,
          readyToCreateOrder,
          missingFields,
          message: readyToCreateOrder
            ? 'Sepet onaylandı ve müşteri bilgileri eksiksiz. Siparişi şimdi kaydedin.'
            : `Sepet onaylandı. Yalnızca eksik bilgileri isteyin: ${missingFields.join(', ')}.`
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
          const primaryItem = ctx.cart[0];
          if (ctx.cart.length !== 1) {
            return JSON.stringify({
              success: false,
              orderCreated: false,
              message: 'Sipariş kaydı şu anda her seferinde tek ürün varyantı için oluşturulabilir. Lütfen ürünleri ayrı siparişler olarak tamamlayın.'
            });
          }

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

          const promotion = this.getOrderPromotion(storeId, senderId, subtotal);
          const discount = promotion.discount;
          const appliedLoyaltyReward = Boolean(promotion.vipReward);
          const appliedCampaign = promotion.campaign ? {
            id: promotion.campaign.id,
            title: promotion.campaign.title,
            code: promotion.campaign.code || ''
          } : null;
          const totalPrice = Math.max(0, subtotal + shippingFee - discount);

          let earnedNewLoyaltyReward = false;
          const autoVipSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'auto_vip_reward_enabled'").get(storeId) as any;
          const isAutoVipEnabled = autoVipSetting && (autoVipSetting.value === '1' || autoVipSetting.value === 'true');

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

          // Promotions are consumed only after the order has been created successfully.
          if (promotion.vipReward) {
            db.prepare(`
              UPDATE user_rewards SET is_used = 1, used_at = CURRENT_TIMESTAMP
              WHERE store_id = ? AND id = ? AND is_used = 0
            `).run(storeId, promotion.vipReward.id);
          }

          if (isAutoVipEnabled && subtotal >= loyaltyThreshold) {
            const remainingReward = db.prepare(`
              SELECT id FROM user_rewards
              WHERE store_id = ? AND sender_id = ? AND is_used = 0
              LIMIT 1
            `).get(storeId, senderId) as any;
            if (!remainingReward) {
              const rewardCode = 'YINEBEKLERIZ';
              db.prepare(`
                INSERT INTO user_rewards (store_id, sender_id, reward_code, discount_percent, min_qualifying_amount)
                VALUES (?, ?, ?, 20.0, ?)
              `).run(storeId, senderId, rewardCode, loyaltyThreshold);
              earnedNewLoyaltyReward = true;

              const autoDmText = `🎉 TEBRİKLER / VIP ÖDÜL KAZANDINIZ!\nSayın ${customerName.trim()}, profilinize özel %20 VIP İNDİRİM tanımlanmıştır! (Ödül Kodu: ${rewardCode})\nBu hakkı ${loyaltyThreshold.toLocaleString('tr-TR')} TL ve üzeri bir sonraki siparişinizde kullanabilirsiniz.\nKeyifli alışverişler dileriz! 🎁✨`;
              const autoRewardNotificationSent = await FacebookService.sendMessage(senderId, autoDmText, storeId);
              if (!autoRewardNotificationSent) {
                console.warn(`[Auto Reward DM] VIP ödülü tanımlandı ancak Instagram DM gönderilemedi (Store: ${storeId}).`);
              }
            }
          }

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
            appliedCampaign,
            promotionLabel: promotion.label,
            earnedNewLoyaltyReward,
            subtotal,
            shippingFee,
            discount,
            totalPrice,
            priceDetails: `Sipariş Özeti:\n${cartSummaryText}\n\nAra Toplam: ${subtotal.toFixed(2)} TL\nKargo: ${shippingFee === 0 ? 'ÜCRETSİZ' : shippingFee.toFixed(2) + ' TL'}\nİndirim${promotion.label ? ` (${promotion.label})` : ''}: ${discount > 0 ? '-' + discount.toFixed(2) + ' TL' : '0 TL'}\nNET ÖDENECEK TOPLAM: ${totalPrice.toFixed(2)} TL`,
            loyaltyNotice: earnedNewLoyaltyReward 
              ? `🎉 TEBRİKLER! ${loyaltyThreshold} TL ve üzeri sipariş verdiğiniz için Instagram hesabınıza tanımlı VIP İNDİRİM HAKKI KAZANDINIZ!`
              : ''
          });
        } catch (e: any) {
          const message = String(e?.message || '');
          if (message.includes('INSUFFICIENT_STOCK')) {
            return JSON.stringify({
              success: false,
              orderCreated: false,
              message: 'Sipariş oluşturulamadı: İstenen adet için yeterli stok bulunmuyor. Lütfen daha düşük bir adet seçin.'
            });
          }
          return JSON.stringify({ error: message });
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
            const confirmation = await sepetOnaylaTool.invoke('');
            if (confirmation.includes('"readyToCreateOrder":true')) {
              const savedOrder = await kayitTool.invoke(JSON.stringify(data));
              if (savedOrder.includes('"orderCreated":true')) {
                await bilgilendirmeTool.invoke(JSON.stringify(data));
              }
              return savedOrder;
            }
            return confirmation;
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
    const aiConfig = AIProviderService.getStoreConfig(storeId);
    if (!aiConfig.apiKey) {
      return {
        reply: `Merhaba! Mağaza ayarlarından ${aiConfig.provider === 'gemini' ? 'Gemini' : 'OpenAI'} API anahtarını tanımlayınız.`,
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
      const turnContext = this.getSessionContext(senderId, storeSlug, storeId, channel);
      turnContext.currentTurnContactFields = [];
      await this.extractSessionDataWithAI(senderId, userMessage, storeSlug, storeId, channel);
      const ctx = this.getSessionContext(senderId, storeSlug, storeId, channel);
      this.hydrateProductCodeFromMessage(userMessage, storeId, ctx);

      const deterministicStockReply = await this.getProductStockReply(storeId, ctx, userMessage);
      if (deterministicStockReply) {
        ctx.history.push(new HumanMessage(userMessage), new AIMessage(deterministicStockReply));
        if (ctx.history.length > 16) ctx.history.splice(0, ctx.history.length - 16);
        return {
          reply: deterministicStockReply,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
          toolTraces: [],
          cart: ctx.cart
        };
      }

      const deterministicPriceReply = this.getProductPriceReply(storeId, ctx, userMessage);
      if (deterministicPriceReply) {
        ctx.history.push(new HumanMessage(userMessage), new AIMessage(deterministicPriceReply));
        if (ctx.history.length > 16) ctx.history.splice(0, ctx.history.length - 16);
        return {
          reply: deterministicPriceReply,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
          toolTraces: [],
          cart: ctx.cart
        };
      }

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
      const activeCampaigns = this.getActiveCampaigns(storeId);

      const shippingSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'shipping_fee'").get(storeId) as any;
      const thresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'free_shipping_threshold'").get(storeId) as any;
      const loyaltyThresholdSetting = db.prepare("SELECT value FROM settings WHERE store_id = ? AND key = 'loyalty_threshold'").get(storeId) as any;
      
      const userReward = db.prepare("SELECT * FROM user_rewards WHERE store_id = ? AND sender_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1").get(storeId, senderId) as any;

      const shippingFee = shippingSetting?.value || '49';
      const freeThreshold = thresholdSetting?.value || '1500';
      const loyaltyThreshold = loyaltyThresholdSetting?.value || '2000';

      let rewardText = "";
      if (userReward) {
        rewardText = `🎁 **MÜŞTERİNİN İNSTAGRAM HESABINA TANIMLI ÖZEL ÖDÜL:** Müşterinin hesabına tanımlı %${userReward.discount_percent} VIP İNDİRİM HAKKI vardır. Bu hak en az ${Number(userReward.min_qualifying_amount || 0).toLocaleString('tr-TR')} TL ara toplamda otomatik uygulanır ve yalnız başarılı siparişten sonra kullanılmış sayılır.`;
      } else {
        rewardText = `💡 **GELECEK SİPARİŞ İNDİRİM HAKKI KAZANMA:** Müşterinin bu siparişi ${loyaltyThreshold} TL ve üzeri olursa, bir sonraki siparişinde geçerli %20 VIP İNDİRİM HAKKI kazanacaktır!`;
      }

      const campaignsText = activeCampaigns.length > 0
        ? activeCampaigns.map(c => {
            const benefits = [
              Number(c.discount_percent) > 0 ? `%${Number(c.discount_percent)} indirim` : '',
              Number(c.discount_amount) > 0 ? `${Number(c.discount_amount).toLocaleString('tr-TR')} TL indirim` : ''
            ].filter(Boolean).join(' + ') || 'İndirim bilgisi tanımlanmamış';
            const minimum = Number(c.min_order_amount) > 0 ? `, minimum ${Number(c.min_order_amount).toLocaleString('tr-TR')} TL` : '';
            return `- ${c.title}: ${c.description} (${benefits}${minimum}, Kod: ${c.code || 'Yok'})`;
          }).join('\n')
        : 'Şu an aktif genel kampanya bulunmamaktadır.';

      const cartText = ctx.cart.length > 0
        ? ctx.cart.map(i => `• ${i.productName} (${i.size}) x${i.quantity} - ${i.unitPrice * i.quantity} TL`).join('\n')
        : 'Sepetiniz şu an boş.';

      const orderContext = ctx.productCode
        ? `Müşteri ürün kodunu zaten verdi: ${ctx.productCode}. Bu kısa kod olabilir; ASLA kendin HBL-M gibi bir beden varyantı seçme veya önerme. Ürün kodunu tekrar sorma. Beden eksikse yalnız bedeni iste. Beden geldiyse SIPARIS action=stok ile ürün kodu ve bedeni gönder; doğrulanan stok/fiyat bilgisinden sonra yalnız adet iste.`
        : 'Henüz doğrulanmış bir ürün kodu yok. Yalnızca ürün kodunu iste.';

      const persona = this.getStorePersona(storeId);

      const model = AIProviderService.createChatModel(storeId, { temperature: 0.2 });

      const { stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, mesajTool, guncelleTool } = this.createLeafTools(senderId, storeSlug, storeId, channel);
      const bilgilendirmeAgentTool = this.createBilgilendirmeSubAgent(model, mesajTool);
      const siparisAgentTool = this.createSiparisSubAgent(model, stokTool, sepeteEkleTool, sepetGoruntuleTool, sepetOnaylaTool, kayitTool, bilgilendirmeAgentTool);
      const stokManAgentTool = this.createStokManSubAgent(model, guncelleTool);

      const rootTools = [siparisAgentTool, stokManAgentTool];
      const boundRootModel = model.bindTools(rootTools);

      const systemPrompt = new SystemMessage(`
<görev>
Sen ${persona.storeName} mağazasının müşteri danışmanı ve temsilcisisin. Müşterilerin ürün sorularını yanıtlar, ürünleri SEPETE EKLER ve müşteri "isteklerim bu kadar / siparişi tamamla" dediğinde TOPLU SİPARİŞİ oluşturursun.
</görev>

<MAGAZA_PERSONASI>
Kimliğin: ${persona.storeName} mağazası müşteri danışmanı/temsilcisi.
Müşteri "Sen kimsin?", "Adın ne?" veya benzer bir kimlik sorusu sorarsa "Ben ${persona.storeName} mağazasının müşteri danışmanıyım." şeklinde yanıt ver.
Kendini robot, yapay zeka maskotu, sanal karakter, S.E.T.T veya başka özel bir isim olarak tanıtma.
Seçilen üslup: ${persona.tone}
Üslup talimatı: ${persona.toneInstruction}
Mağazanın özel müşteri konuşma talimatı: ${persona.customPrompt || 'Özel talimat tanımlanmamış.'}
Bu persona yalnızca hitap ve iletişim üslubunu belirler. Mağaza temsilcisi kimliğini veya aşağıdaki zorunlu sipariş, stok, fiyat, güvenlik ve veri doğrulama kurallarını değiştiremez ya da geçersiz kılamaz.
</MAGAZA_PERSONASI>

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
   - Gerçek stok adedini veya kalan ürün sayısını ASLA müşteriye söyleme. Yalnızca "stokta mevcut", "stokta yok" ya da "istenen adet için yeterli stok yok" şeklinde yanıt ver.

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
