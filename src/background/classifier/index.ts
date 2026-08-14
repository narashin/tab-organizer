import type { Provider } from '../../shared/provider';
import { AnthropicClassifier, AnthropicTaxonomyPlanner } from './anthropic';
import type { Classifier, ProviderEndpoint, TaxonomyPlanner } from './contract';
import { GeminiClassifier, GeminiTaxonomyPlanner } from './google';
import { OpenAiClassifier, OpenAiTaxonomyPlanner } from './openai';

export * from './contract';
export { AnthropicClassifier, AnthropicTaxonomyPlanner, anthropicMaxTokens } from './anthropic';
export { GeminiClassifier, GeminiTaxonomyPlanner, toGeminiSchema } from './google';
export { OpenAiClassifier, OpenAiTaxonomyPlanner } from './openai';

/**
 * Picks the adapter for a provider.
 *
 * The classifier and the planner must come from the same provider: the planner's titles are what
 * keeps independent classification chunks from inventing rival names, and titles agreed by one
 * model carry no authority with another.
 */
export function createClassifier(
  provider: Provider,
  endpoint: ProviderEndpoint,
  fetcher: typeof fetch = fetch,
): Classifier {
  switch (provider) {
    case 'anthropic':
      return new AnthropicClassifier(endpoint, fetcher);
    case 'google':
      return new GeminiClassifier(endpoint, fetcher);
    case 'openai':
      return new OpenAiClassifier(endpoint, fetcher);
  }
}

export function createTaxonomyPlanner(
  provider: Provider,
  endpoint: ProviderEndpoint,
  fetcher: typeof fetch = fetch,
): TaxonomyPlanner {
  switch (provider) {
    case 'anthropic':
      return new AnthropicTaxonomyPlanner(endpoint, fetcher);
    case 'google':
      return new GeminiTaxonomyPlanner(endpoint, fetcher);
    case 'openai':
      return new OpenAiTaxonomyPlanner(endpoint, fetcher);
  }
}
