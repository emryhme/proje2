import { StockService } from './stock.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { AIProviderService } from './ai-provider.service';

export interface AIProductItem {
  shortCode: string;
  productCode: string;
  name: string;
  color: string;
  size: string;
  stock: number;
  category: string;
}

export interface AIBatchResult {
  success: boolean;
  products?: AIProductItem[];
  aiMessage?: string;
  error?: string;
}

/**
 * Google Gemini Yapay Zeka Tabanlı Multi-Tenant Akıllı Ürün Oluşturucu Servisi
 */
export class GeminiService {
  private static validateStoreId(storeId: any): void {
    if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
      throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
    }
  }

  /**
   * Doğal dil komutundan Gemini AI kullanarak ürün dizisi oluşturur ve veritabanına kaydedici (Store Isolated).
   */
  public static async createProductFromPrompt(prompt: string, storeId: number): Promise<AIBatchResult> {
    this.validateStoreId(storeId);
    try {
      const aiConfig = AIProviderService.getStoreConfig(storeId);
      let parsedProducts: AIProductItem[] = [];
      let customAiMessage = '';

      if (aiConfig.apiKey) {
        console.log(`[AI Product] 🤖 ${aiConfig.provider} ile ürün(ler) ayrıştırılıyor (Store: ${storeId})...`);
        const aiResult = await this.callSelectedProvider(prompt, storeId);
        if (aiResult && aiResult.products && aiResult.products.length > 0) {
          parsedProducts = aiResult.products;
          customAiMessage = aiResult.aiMessage;
        }
      } else {
        console.log('[AI Product] 🔑 Mağaza API anahtarı bulunamadı, Akıllı Kural Motoru çalışıyor...');
      }

      if (!parsedProducts || parsedProducts.length === 0) {
        parsedProducts = this.fallbackSmartBatchParser(prompt);
      }

      if (!parsedProducts || parsedProducts.length === 0) {
        return { success: false, error: 'Ürün bilgisi ayrıştırılamadı.' };
      }

      const savedProducts: AIProductItem[] = [];

      for (const item of parsedProducts) {
        const cleanShortCode = (item.shortCode || 'SKG').toUpperCase().trim();
        const cleanSize = (item.size || 'M').toUpperCase().trim();
        const cleanProductCode = item.productCode || `${cleanShortCode}-${cleanSize}`;
        const cleanName = item.name || 'Siyah Kot Gömlek';
        const cleanColor = item.color || 'Siyah';
        const cleanStock = Number(item.stock) || 50;
        const cleanCategory = item.category || 'Gömlek';

        await StockService.addProduct({
          storeId: storeId,
          shortCode: cleanShortCode,
          productCode: cleanProductCode,
          name: cleanName,
          color: cleanColor,
          size: cleanSize,
          stock: cleanStock,
          category: cleanCategory
        });

        savedProducts.push({
          shortCode: cleanShortCode,
          productCode: cleanProductCode,
          name: cleanName,
          color: cleanColor,
          size: cleanSize,
          stock: cleanStock,
          category: cleanCategory
        });

      }

      const totalStockAdded = savedProducts.reduce((acc, p) => acc + p.stock, 0);
      const sizesStr = savedProducts.map(p => p.size).join(', ');

      return {
        success: true,
        products: savedProducts,
        aiMessage: customAiMessage || `⚡ ${savedProducts.length} farklı beden (${sizesStr}) için toplam ${totalStockAdded} adet ürün stok tablosuna anında eklendi!`
      };

    } catch (error: any) {
      console.error('[GeminiService Error]:', error?.message || error);
      return { success: false, error: error?.message || 'Yapay zeka ürün oluşturma hatası' };
    }
  }

  /**
   * Mağazanın seçtiği yapay zeka sağlayıcısıyla yapılandırılmış ürün çıkarımı.
   */
  private static async callSelectedProvider(prompt: string, storeId: number): Promise<{ products: AIProductItem[]; aiMessage: string } | null> {
    try {
      const systemInstruction = `
Sen ISCWORKS e-ticaret yönetim paneli için Akıllı Ürün Ekleyici yapay zeka asistanısın.
Kullanıcının doğal dille yazdığı Türkçe metinden ürün bilgilerini çıkar.
Eğer kullanıcı tek bir cümlede birden fazla beden belirttiyse, HER BEDEN İÇİN AYRI BIR ÜRÜN OBJESİ OLUŞTUR.

ZORUNLU JSON ŞEMASI:
{
  "products": [
    {
      "shortCode": "Ürün koda eşleşimi (Örn: SKG, KGMLW).",
      "productCode": "Tam ürün kodu (Örn: SKG-XS, SKG-S).",
      "name": "Temiz ürün tam adı.",
      "color": "Ürün rengi.",
      "size": "Yalnızca bu varyantın bedeni.",
      "stock": 50,
      "category": "Kategori."
    }
  ],
  "aiMessage": "Kullanıcıya bilgi veren Türkçe kısa özet açıklama."
}
`;

      const model = AIProviderService.createChatModel(storeId, { temperature: 0.1 });
      const response = await model.invoke([
        new SystemMessage(systemInstruction),
        new HumanMessage(`Kullanıcı Girdisi: "${prompt}"\nYalnızca geçerli JSON döndür.`)
      ]);
      const textResponse = typeof response.content === 'string' ? response.content : '';
      if (textResponse) {
        const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
      }
      return null;
    } catch (err: any) {
      console.warn('[AI Product Fallback Triggered]:', err?.response?.data || err?.message);
      return null;
    }
  }

  /**
   * Çoklu Beden Destekli Akıllı Kural Motoru
   */
  private static fallbackSmartBatchParser(prompt: string): AIProductItem[] {
    const rawText = prompt.trim();
    const upperText = rawText.toUpperCase();

    let shortCode = '';
    const codeMatch = upperText.match(/(?:ÜRÜN KODU|KISA KOD|KODU|KOD)[:\s]+([A-Z0-9]{2,8})/);
    if (codeMatch) {
      shortCode = codeMatch[1].trim();
    } else {
      const words = upperText.split(/\s+/);
      const candidates = words.filter(w => /^[A-Z]{3,6}$/.test(w) && !['GELDİ', 'TANE', 'STOK', 'VAR', 'HER', 'ÜRÜN', 'KODU', 'BEDEN'].includes(w));
      shortCode = candidates.length > 0 ? candidates[candidates.length - 1] : 'SKG';
    }

    const colors = ['Siyah', 'Beyaz', 'Mavi', 'Kırmızı', 'Yeşil', 'Sarı', 'Kahverengi', 'Gri', 'Lacivert', 'Kırmızı-Siyah'];
    const foundColor = colors.find(c => rawText.toLowerCase().includes(c.toLowerCase())) || 'Siyah';

    const categories = ['Gömlek', 'Pantolon', 'T-Shirt', 'Ceket', 'Ayakkabı', 'Parfüm', 'Aksesuar'];
    const foundCategory = categories.find(c => rawText.toLowerCase().includes(c.toLowerCase())) || 'Gömlek';

    const stockMatch = rawText.match(/(\d+)\s*(?:TANE|ADET|STOK|KADAR)?/i);
    const stock = stockMatch ? parseInt(stockMatch[1], 10) : 50;

    const possibleSizes = ['XXL', '2XL', '3XL', 'XL', 'XS', 'S', 'M', 'L', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45'];
    const detectedSizes: string[] = [];

    for (const sz of possibleSizes) {
      const regex = new RegExp(`\\b${sz}\\b`, 'i');
      if (regex.test(upperText)) {
        detectedSizes.push(sz);
      }
    }

    const finalSizes = detectedSizes.length > 0 ? Array.from(new Set(detectedSizes)) : ['M'];

    let titlePart = rawText.split(/GELDİ|HER BEDENDEN|BEDENLERİ|ÜRÜN KODU|KISA KOD|STOK|VAR/i)[0].trim();
    if (!titlePart || titlePart.length < 3) {
      titlePart = `${foundColor} Kot ${foundCategory}`;
    }

    const cleanName = titlePart.split(/\s+/).map(w => {
      if (!w) return '';
      const lower = w.toLowerCase();
      if (w.startsWith('İ') || w.startsWith('i')) return 'İ' + lower.slice(1);
      if (w.startsWith('I') || w.startsWith('ı')) return 'I' + lower.slice(1);
      return w.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');

    return finalSizes.map(sz => ({
      shortCode,
      productCode: `${shortCode}-${sz}`,
      name: cleanName,
      color: foundColor,
      size: sz,
      stock,
      category: foundCategory
    }));
  }
}
