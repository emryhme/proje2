import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { db } from '../database/db';
import { decryptSettingSecret } from '../utils/secret.util';

export type AIProvider = 'openai' | 'gemini';

export interface StoreAIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
}

export type StoreChatModel = ChatOpenAI | ChatGoogleGenerativeAI;

export class AIProviderService {
  private static readonly DEFAULT_MODELS: Record<AIProvider, string> = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-3.5-flash-lite'
  };

  public static getStoreConfig(storeId: number): StoreAIConfig {
    if (!Number.isInteger(storeId) || storeId <= 0) throw new Error('Geçerli mağaza kimliği zorunludur.');
    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('ai_provider', 'ai_api_key', 'openai_api_key', 'gemini_api_key')
    `).all(storeId) as Array<{ key: string; value: string }>;
    const settings = Object.fromEntries(rows.map(row => [row.key, String(row.value || '')]));
    const provider: AIProvider = settings.ai_provider === 'gemini' ? 'gemini' : 'openai';
    const providerKey = provider === 'gemini' ? settings.gemini_api_key : settings.openai_api_key;
    const apiKey = decryptSettingSecret(providerKey || settings.ai_api_key || '').trim();
    return { provider, apiKey, model: this.DEFAULT_MODELS[provider] };
  }

  public static hasStoreApiKey(storeId: number): boolean {
    return Boolean(this.getStoreConfig(storeId).apiKey);
  }

  public static createChatModel(storeId: number, options: { temperature?: number; model?: string } = {}): StoreChatModel {
    const config = this.getStoreConfig(storeId);
    if (!config.apiKey) {
      throw new Error(`${config.provider === 'gemini' ? 'Gemini' : 'OpenAI'} API anahtarı bu mağaza için tanımlanmamış.`);
    }
    if (config.provider === 'gemini') {
      return new ChatGoogleGenerativeAI({
        apiKey: config.apiKey,
        model: options.model || config.model,
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: 2048
      });
    }
    return new ChatOpenAI({
      apiKey: config.apiKey,
      model: options.model || config.model,
      temperature: options.temperature ?? 0.2
    });
  }
}
