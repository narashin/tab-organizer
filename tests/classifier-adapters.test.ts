import { describe, expect, it } from 'vitest';

import {
  anthropicMaxTokens,
  createClassifier,
  createTaxonomyPlanner,
  toGeminiSchema,
  type ClassificationRequest,
  type TaxonomyRequest,
} from '../src/background/classifier';
import { PROVIDER_PROFILES, PROVIDERS, type Provider } from '../src/shared/provider';

const request: ClassificationRequest = {
  mode: 'synchronization',
  locale: 'en',
  tabs: [
    { ref: 'tab-1', title: 'Apollo billing', hostname: 'billing.example.test', currentGroup: null },
    { ref: 'tab-2', title: 'Release notes', hostname: 'wiki.example.test', currentGroup: null },
  ],
  groups: [{ ref: 'group-7', title: 'Apollo', color: 'blue' }],
  presets: [
    { id: 'preset-1', name: 'Docs', description: 'Wiki pages', cues: [], color: 'green' },
  ],
};

const decisions = {
  decisions: [
    {
      tabRef: 'tab-1',
      kind: 'existing_group',
      targetRef: 'group-7',
      suggestedName: null,
      suggestedDescription: null,
      confidence: 0.91,
      reason: 'Billing belongs with Apollo',
    },
    {
      tabRef: 'tab-2',
      kind: 'preset',
      targetRef: 'preset-1',
      suggestedName: null,
      suggestedDescription: null,
      confidence: 0.72,
      reason: 'Wiki page',
    },
  ],
};

/** Wraps the same decision payload in each provider's own response envelope. */
function respondWith(provider: Provider, payload: unknown): Response {
  const text = JSON.stringify(payload);
  if (provider === 'anthropic') {
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  }
  if (provider === 'google') {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
      { status: 200 },
    );
  }
  return new Response(
    JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
    { status: 200 },
  );
}

function endpointFor(provider: Provider) {
  return {
    apiKey: 'key-sensitive',
    model: PROVIDER_PROFILES[provider].defaultModel,
    baseUrl: PROVIDER_PROFILES[provider].defaultBaseUrl,
  };
}

describe('classifier adapters', () => {
  it.each(PROVIDERS)('returns the same decisions from %s', async (provider) => {
    const classifier = createClassifier(
      provider,
      endpointFor(provider),
      async () => respondWith(provider, decisions),
    );

    await expect(classifier.classify(request)).resolves.toEqual(decisions.decisions);
  });

  it.each(PROVIDERS)('fails one chunk, not the batch, when %s breaks the schema', async (provider) => {
    // A decision for a tab that was never sent means the whole response is untrustworthy.
    const classifier = createClassifier(
      provider,
      endpointFor(provider),
      async () => respondWith(provider, {
        decisions: [{ ...decisions.decisions[0], tabRef: 'tab-999' }],
      }),
    );

    await expect(classifier.classify(request)).rejects.toThrow('classification_invalid_response');
  });

  it.each(PROVIDERS)('reports an HTTP failure from %s as a request failure', async (provider) => {
    const classifier = createClassifier(
      provider,
      endpointFor(provider),
      async () => new Response('{"error":"nope"}', { status: 500 }),
    );

    await expect(classifier.classify(request)).rejects.toThrow('classification_request_failed');
  });

  it('asks Anthropic for JSON with an output ceiling that scales with the chunk', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const classifier = createClassifier('anthropic', endpointFor('anthropic'), async (input, init) => {
      url = input.toString();
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return respondWith('anthropic', decisions);
    });

    await classifier.classify(request);

    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('key-sensitive');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    // Anthropic requires the ceiling; too low truncates the JSON instead of reporting a limit.
    expect(body.max_tokens).toBe(anthropicMaxTokens(request.tabs.length));
    expect(anthropicMaxTokens(200)).toBeLessThanOrEqual(8_192);
    expect(anthropicMaxTokens(0)).toBeGreaterThanOrEqual(1_024);
  });

  it('asks Gemini for JSON and keeps the key out of the URL', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const classifier = createClassifier('google', endpointFor('google'), async (input, init) => {
      url = input.toString();
      headers = Object.fromEntries(new Headers(init?.headers).entries());
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return respondWith('google', decisions);
    });

    await classifier.classify(request);

    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    );
    expect(url).not.toContain('key-sensitive');
    expect(headers['x-goog-api-key']).toBe('key-sensitive');
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
  });

  it('keeps a model name inside its own path segment', async () => {
    let url = '';
    const classifier = createClassifier(
      'google',
      { ...endpointFor('google'), model: 'models/../../v1beta/openai' },
      async (input) => { url = input.toString(); return respondWith('google', decisions); },
    );

    await classifier.classify(request);

    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/models%2F..%2F..%2Fv1beta%2Fopenai:generateContent',
    );
  });

  it('rewrites the shared schema into the subset Gemini accepts', () => {
    const converted = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      required: ['decisions'],
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'targetRef', 'confidence'],
            properties: {
              kind: { type: 'string', enum: ['no_change'] },
              targetRef: { type: ['string', 'null'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    });

    expect(converted).toEqual({
      type: 'OBJECT',
      required: ['decisions'],
      properties: {
        decisions: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            required: ['kind', 'targetRef', 'confidence'],
            properties: {
              kind: { type: 'STRING', enum: ['no_change'] },
              // A union with null becomes a flag, since Gemini has no union type.
              targetRef: { type: 'STRING', nullable: true },
              confidence: { type: 'NUMBER' },
            },
            propertyOrdering: ['kind', 'targetRef', 'confidence'],
          },
        },
      },
      propertyOrdering: ['decisions'],
    });
    // Keywords Gemini rejects outright must not survive the rewrite.
    expect(JSON.stringify(converted)).not.toContain('additionalProperties');
    expect(JSON.stringify(converted)).not.toContain('minimum');
  });

  it.each(PROVIDERS)('plans a taxonomy through %s', async (provider) => {
    const taxonomyRequest: TaxonomyRequest = {
      locale: 'en',
      tabs: [{ ref: 'tab-1', title: 'Apollo billing', hostname: 'billing.example.test' }],
      groups: [{ ref: 'group-7', title: 'Apollo', color: 'blue' }],
      presets: [],
      maxTitles: 3,
    };
    const planner = createTaxonomyPlanner(
      provider,
      endpointFor(provider),
      async () => respondWith(provider, { groups: [{ title: 'Apollo' }, { title: 'Docs' }] }),
    );

    await expect(planner.plan(taxonomyRequest)).resolves.toEqual([
      // A title that matches a supplied group resolves to that group rather than a new one.
      { title: 'Apollo', kind: 'existing_group', ref: 'group-7' },
      { title: 'Docs', kind: 'new_group', ref: null },
    ]);
  });
});
