import { DEFAULT_API_BASE_URL } from './base-url';

export type Provider = 'openai' | 'anthropic' | 'google';

export const PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'google'];
export const DEFAULT_PROVIDER: Provider = 'openai';

export interface ProviderProfile {
  /**
   * The model the extension starts with. A user who types their own model keeps it; this only
   * decides what a provider looks like before anyone has chosen.
   */
  defaultModel: string;
  defaultBaseUrl: string;
}

export const PROVIDER_PROFILES: Record<Provider, ProviderProfile> = {
  openai: {
    defaultModel: 'gpt-5.6',
    defaultBaseUrl: DEFAULT_API_BASE_URL,
  },
  anthropic: {
    defaultModel: 'claude-opus-5',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
  },
  google: {
    // Gemini puts the model in the request path rather than the body, so the value has to survive
    // URL construction as well as the request payload.
    defaultModel: 'gemini-3.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
};

export function isProvider(value: unknown): value is Provider {
  return value === 'openai' || value === 'anthropic' || value === 'google';
}

export function createProviderRecord<T>(create: (provider: Provider) => T): Record<Provider, T> {
  return {
    openai: create('openai'),
    anthropic: create('anthropic'),
    google: create('google'),
  };
}
