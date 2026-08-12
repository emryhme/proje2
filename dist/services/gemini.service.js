"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiService = void 0;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const stock_service_1 = require("./stock.service");
/**
 * Google Gemini Yapay Zeka Tabanlı Multi-Tenant Akıllı Ürün Oluşturucu Servisi
 */
class GeminiService {
    static validateStoreId(storeId) {
        if (typeof storeId !== 'number' || isNaN(storeId) || storeId <= 0) {
            throw new Error('Store ID zorunludur ve geçerli bir pozitif sayı olmalıdır.');
        }
    }
    /**
     * Doğal dil komutundan Gemini AI kullanarak ürün dizisi oluşturur ve veritabanına kaydedici (Store Isolated).
     */
    static async createProductFromPrompt(prompt, storeId) {
        this.validateStoreId(storeId);
        try {
            const apiKey = env_1.env.geminiApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
            let parsedProducts = [];
            let customAiMessage = '';
            if (apiKey) {
                console.log(`[GeminiService] 🤖 Google Gemini AI ile ürün(ler) ayrıştırılıyor (Store: ${storeId})...`);
                const geminiResult = await this.callGeminiAPI(prompt, apiKey);
                if (geminiResult && geminiResult.products && geminiResult.products.length > 0) {
                    parsedProducts = geminiResult.products;
                    customAiMessage = geminiResult.aiMessage;
                }
            }
            else {
                console.log('[GeminiService] 🔑 Gemini API key bulunamadı, Akıllı Kural Motoru çalışıyor...');
            }
            if (!parsedProducts || parsedProducts.length === 0) {
                parsedProducts = this.fallbackSmartBatchParser(prompt);
            }
            if (!parsedProducts || parsedProducts.length === 0) {
                return { success: false, error: 'Ürün bilgisi ayrıştırılamadı.' };
            }
            const savedProducts = [];
            for (const item of parsedProducts) {
                const cleanShortCode = (item.shortCode || 'SKG').toUpperCase().trim();
                const cleanSize = (item.size || 'M').toUpperCase().trim();
                const cleanProductCode = item.productCode || `${cleanShortCode}-${cleanSize}`;
                const cleanName = item.name || 'Siyah Kot Gömlek';
                const cleanColor = item.color || 'Siyah';
                const cleanStock = Number(item.stock) || 50;
                const cleanCategory = item.category || 'Gömlek';
                await stock_service_1.StockService.addProduct({
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
        }
        catch (error) {
            console.error('[GeminiService Error]:', error?.message || error);
            return { success: false, error: error?.message || 'Yapay zeka ürün oluşturma hatası' };
        }
    }
    /**
     * Google Gemini REST API Çağrısı
     */
    static async callGeminiAPI(prompt, apiKey) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
            const systemInstruction = `
Sen BARON'S SILLAGE e-ticaret yönetim paneli için Akıllı Ürün Ekleyici yapay zeka asistanısın.
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
            const response = await axios_1.default.post(url, {
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: `${systemInstruction}\n\nKullanıcı Girdisi: "${prompt}"` }
                        ]
                    }
                ],
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.1
                }
            }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
            const textResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textResponse) {
                const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
                return JSON.parse(cleanJson);
            }
            return null;
        }
        catch (err) {
            console.warn('[Gemini API Fallback Triggered]:', err?.response?.data || err?.message);
            return null;
        }
    }
    /**
     * Çoklu Beden Destekli Akıllı Kural Motoru
     */
    static fallbackSmartBatchParser(prompt) {
        const rawText = prompt.trim();
        const upperText = rawText.toUpperCase();
        let shortCode = '';
        const codeMatch = upperText.match(/(?:ÜRÜN KODU|KISA KOD|KODU|KOD)[:\s]+([A-Z0-9]{2,8})/);
        if (codeMatch) {
            shortCode = codeMatch[1].trim();
        }
        else {
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
        const detectedSizes = [];
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
            if (!w)
                return '';
            const lower = w.toLowerCase();
            if (w.startsWith('İ') || w.startsWith('i'))
                return 'İ' + lower.slice(1);
            if (w.startsWith('I') || w.startsWith('ı'))
                return 'I' + lower.slice(1);
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
exports.GeminiService = GeminiService;
