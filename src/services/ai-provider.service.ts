import { ChatOpenAI } from '@langchain/openai';
import { db } from '../database/db';
import { decryptSettingSecret } from '../utils/secret.util';

export type AIProvider = 'openai' | 'gemini';

export interface StoreAIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
}

export class AIProviderService {
  private static readonly DEFAULT_MODELS: Record<AIProvider, string> = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.5-flash'
  };

  public static getStoreConfig(storeId: number): StoreAIConfig {
    if (!Number.isInteger(storeId) || storeId <= 0) throw new Error('Geçerli mağaza kimliği zorunludur.');
    const rows = db.prepare(`
      SELECT key, value FROM settings
      WHERE store_id = ? AND key IN ('ai_provider', 'ai_api_key')
    `).all(storeId) as Array<{ key: string; value: string }>;
    const settings = Object.fromEntries(rows.map(row => [row.key, String(row.value || '')]));
    const provider: AIProvider = settings.ai_provider === 'gemini' ? 'gemini' : 'openai';
    const apiKey = decryptSettingSecret(settings.ai_api_key || '').trim();
    return { provider, apiKey, model: this.DEFAULT_MODELS[provider] };
  }

  public static hasStoreApiKey(storeId: number): boolean {
    return Boolean(this.getStoreConfig(storeId).apiKey);
  }

  public static createChatModel(storeId: number, options: { temperature?: number; model?: string } = {}): ChatOpenAI {
    const config = this.getStoreConfig(storeId);
    if (!config.apiKey) {
      throw new Error(`${config.provider === 'gemini' ? 'Gemini' : 'OpenAI'} API anahtarı bu mağaza için tanımlanmamış.`);
    }
    return new ChatOpenAI({
      openAIApiKey: config.apiKey,
      modelName: options.model || config.model,
      temperature: options.temperature ?? 0.2,
      ...(config.provider === 'gemini'
        ? { configuration: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' } }
        : {})
    });
  }
}
