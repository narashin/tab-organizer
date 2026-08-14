import { ANTHROPIC_VERSION } from '../provider-key';
import {
  buildClassificationInstructions,
  buildTaxonomyInstructions,
  classificationTimeoutMs,
  decisionSchema,
  isRecord,
  resolveTaxonomy,
  taxonomySchema,
  TAXONOMY_TIMEOUT_MS,
  validateDecisions,
  withTimeout,
  type ClassificationDecision,
  type ClassificationRequest,
  type Classifier,
  type ProviderEndpoint,
  type TaxonomyEntry,
  type TaxonomyPlanner,
  type TaxonomyRequest,
} from './contract';

/**
 * Anthropic requires an output ceiling on every request, and a ceiling that is too low truncates the
 * JSON mid-object, which then fails schema validation rather than reporting a limit. One decision
 * costs roughly 55 output tokens; the multiplier leaves room for longer reasons and non-ASCII text.
 */
const OUTPUT_TOKENS_PER_TAB = 160;
const MIN_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 8_192;

export function anthropicMaxTokens(tabCount: number): number {
  const requested = MIN_OUTPUT_TOKENS + tabCount * OUTPUT_TOKENS_PER_TAB;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, requested));
}

function headers(endpoint: ProviderEndpoint): Record<string, string> {
  return {
    'x-api-key': endpoint.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
  };
}

function requestBody(
  endpoint: ProviderEndpoint,
  instructions: string,
  input: unknown,
  schema: unknown,
  maxTokens: number,
): string {
  return JSON.stringify({
    model: endpoint.model,
    max_tokens: maxTokens,
    system: instructions,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    output_config: { format: { type: 'json_schema', schema } },
  });
}

/** Reads the first text block out of a Messages API response. */
export function extractAnthropicText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    return null;
  }
  for (const block of payload.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

export class AnthropicClassifier implements Classifier {
  constructor(
    private readonly endpoint: ProviderEndpoint,
    private readonly fetcher: typeof fetch = fetch,
    private readonly configuredTimeoutMs?: number,
  ) {}

  async classify(request: ClassificationRequest): Promise<ClassificationDecision[]> {
    const requestTimeoutMs = this.configuredTimeoutMs ?? classificationTimeoutMs(request.tabs.length);
    const requestController = new AbortController();
    const response = await withTimeout((signal) => this.fetcher(
      `${this.endpoint.baseUrl}/messages`,
      {
        method: 'POST',
        headers: headers(this.endpoint),
        body: requestBody(
          this.endpoint,
          buildClassificationInstructions(request.approvedGroupTitles),
          request,
          decisionSchema,
          anthropicMaxTokens(request.tabs.length),
        ),
        signal,
      },
    ), requestTimeoutMs, requestController);

    if (!response.ok) {
      throw new Error('classification_request_failed');
    }

    let payload: unknown;
    try {
      payload = await withTimeout(() => response.json(), requestTimeoutMs, requestController);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'classification_request_timeout') {
        throw error;
      }
      throw new Error('classification_invalid_response');
    }

    const outputText = extractAnthropicText(payload);
    if (outputText === null) {
      throw new Error('classification_invalid_response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error('classification_invalid_response');
    }
    return validateDecisions(parsed, request);
  }
}

export class AnthropicTaxonomyPlanner implements TaxonomyPlanner {
  constructor(
    private readonly endpoint: ProviderEndpoint,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = TAXONOMY_TIMEOUT_MS,
  ) {}

  async plan(request: TaxonomyRequest): Promise<TaxonomyEntry[]> {
    const requestController = new AbortController();
    const response = await withTimeout((signal) => this.fetcher(
      `${this.endpoint.baseUrl}/messages`,
      {
        method: 'POST',
        headers: headers(this.endpoint),
        body: requestBody(
          this.endpoint,
          buildTaxonomyInstructions(request.maxTitles),
          request,
          taxonomySchema,
          MIN_OUTPUT_TOKENS,
        ),
        signal,
      },
    ), this.requestTimeoutMs, requestController);

    if (!response.ok) {
      throw new Error('taxonomy_request_failed');
    }

    let payload: unknown;
    try {
      payload = await withTimeout(() => response.json(), this.requestTimeoutMs, requestController);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'classification_request_timeout') {
        throw error;
      }
      throw new Error('taxonomy_invalid_response');
    }

    const outputText = extractAnthropicText(payload);
    if (outputText === null) {
      throw new Error('taxonomy_invalid_response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error('taxonomy_invalid_response');
    }
    return resolveTaxonomy(parsed, request);
  }
}
