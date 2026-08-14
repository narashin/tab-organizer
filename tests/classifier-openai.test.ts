import { describe, expect, it, vi } from 'vitest';

import {
  CLASSIFICATION_TIMEOUT_FLOOR_MS,
  CLASSIFICATION_TIMEOUT_PER_TAB_MS,
  OpenAiClassifier,
  OpenAiTaxonomyPlanner,
  TAXONOMY_MAX_TITLES,
  classificationTimeoutMs,
  type ClassificationRequest,
} from '../src/background/classifier';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const endpoint = { apiKey: 'sk-project-sensitive', model: 'gpt-5.6', baseUrl: DEFAULT_BASE_URL };

const request: ClassificationRequest = {
  mode: 'automatic',
  locale: 'en',
  tabs: [
    {
      ref: 'tab-42',
      title: 'Apollo billing dashboard',
      hostname: 'billing.example.test',
      currentGroup: null,
    },
  ],
  groups: [{ ref: 'group-7', title: 'Apollo', color: 'blue' }],
  presets: [
    {
      id: 'preset-1',
      name: 'Apollo',
      description: 'Internal billing platform',
      cues: ['APOLLO-'],
      color: 'blue',
    },
  ],
};

describe('OpenAiClassifier', () => {
  it('uses strict Responses API output and returns validated decisions', async () => {
    let body: unknown;
    let authorization = '';
    const fetcher: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    decisions: [
                      {
                        tabRef: 'tab-42',
                        kind: 'existing_group',
                        targetRef: 'group-7',
                        suggestedName: null,
                        suggestedDescription: null,
                        confidence: 0.96,
                        reason: 'Matches Apollo billing',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    };
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const result = await classifier.classify(request);

    expect(result).toEqual([
      {
        tabRef: 'tab-42',
        kind: 'existing_group',
        targetRef: 'group-7',
        suggestedName: null,
        suggestedDescription: null,
        confidence: 0.96,
        reason: 'Matches Apollo billing',
      },
    ]);
    expect(authorization).toBe('Bearer sk-project-sensitive');
    expect(body).toMatchObject({
      model: 'gpt-5.6',
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).toContain('billing.example.test');
    expect(serializedBody).not.toContain('https://');
    expect(serializedBody).not.toContain('pageContent');
  });

  it('instructs the model to reuse existing targets before creating a group', async () => {
    let instructions = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === 'object' && parsed !== null && 'instructions' in parsed) {
        instructions = String((parsed as { instructions: unknown }).instructions);
      }
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    };
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(classifier.classify(request)).rejects.toThrow(
      'classification_invalid_response',
    );
    expect(instructions).toContain('existing_group');
    expect(instructions).toContain('preset');
    expect(instructions).toContain('new_group only when none of the above fits');
    expect(instructions).toContain('must not copy or closely resemble');
    expect(instructions).toContain('targetRef');
    expect(instructions).toContain('locale');
  });

  it('sends classification to the configured endpoint rather than a fixed one', async () => {
    let receivedUrl = '';
    const fetcher: typeof fetch = async (input) => {
      receivedUrl = input.toString();
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    };
    const classifier = new OpenAiClassifier(
      { ...endpoint, baseUrl: 'https://gateway.example.test/v1' }, fetcher,
    );

    await expect(classifier.classify(request)).rejects.toThrow('classification_invalid_response');
    expect(receivedUrl).toBe('https://gateway.example.test/v1/responses');
  });

  it('restricts new group titles to the approved list when one is supplied', async () => {
    let instructions = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === 'object' && parsed !== null && 'instructions' in parsed) {
        instructions = String((parsed as { instructions: unknown }).instructions);
      }
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    };
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(
      classifier.classify({ ...request, approvedGroupTitles: ['Work', 'Travel'] }),
    ).rejects.toThrow('classification_invalid_response');
    expect(instructions).toContain('Work, Travel');
    expect(instructions).toContain('exactly one of these approved titles');
  });

  it('omits the approved-title constraint when no list is supplied', async () => {
    let instructions = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === 'object' && parsed !== null && 'instructions' in parsed) {
        instructions = String((parsed as { instructions: unknown }).instructions);
      }
      return new Response(JSON.stringify({ output: [] }), { status: 200 });
    };
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(classifier.classify(request)).rejects.toThrow('classification_invalid_response');
    expect(instructions).not.toContain('approved titles');
  });

  it('rejects unknown tab references and malformed output atomically', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: '{"decisions":[{"tabRef":"unknown","kind":"no_change"}]}',
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(classifier.classify(request)).rejects.toThrow(
      'classification_invalid_response',
    );
  });

  it.each([401, 429, 500])('rejects HTTP %s without a local fallback', async (status) => {
    const fetcher: typeof fetch = async () => new Response(null, { status });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(classifier.classify(request)).rejects.toThrow('classification_request_failed');
  });

  it('keeps a nameless new-group decision from creating an untitled group', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({
        decisions: [{ tabRef: 'tab-42', kind: 'new_group', targetRef: null,
          suggestedName: null, suggestedDescription: null, confidence: 0.8, reason: 'Related' }],
      }) }] }],
    }), { status: 200 });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const decisions = await classifier.classify(request);

    expect(decisions[0]).toMatchObject({ kind: 'no_change', suggestedName: null });
  });

  it('drops fields the target resolver never reads instead of discarding the batch', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            decisions: [{
              tabRef: 'tab-42',
              kind: 'existing_group',
              targetRef: 'group-7',
              suggestedName: 'Apollo',
              suggestedDescription: 'Redundant but harmless',
              confidence: 0.9,
              reason: 'Matches Apollo',
            }],
          }),
        }],
      }],
    }), { status: 200 });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const decisions = await classifier.classify(request);

    expect(decisions).toEqual([{
      tabRef: 'tab-42',
      kind: 'existing_group',
      targetRef: 'group-7',
      suggestedName: null,
      suggestedDescription: null,
      confidence: 0.9,
      reason: 'Matches Apollo',
    }]);
  });

  it('drops a stray target reference on a no-change decision', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            decisions: [{
              tabRef: 'tab-42', kind: 'no_change', targetRef: 'group-7',
              suggestedName: null, suggestedDescription: null, confidence: 0.4, reason: 'Fits already',
            }],
          }),
        }],
      }],
    }), { status: 200 });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const decisions = await classifier.classify(request);

    expect(decisions[0]).toMatchObject({ kind: 'no_change', targetRef: null });
  });

  it('recovers a target the model named instead of referenced', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            decisions: [{
              tabRef: 'tab-42', kind: 'preset', targetRef: null,
              suggestedName: 'Apollo', suggestedDescription: 'Internal billing platform',
              confidence: 0.9, reason: 'Named the preset instead of referencing it',
            }],
          }),
        }],
      }],
    }), { status: 200 });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const decisions = await classifier.classify(request);

    expect(decisions[0]).toMatchObject({ kind: 'preset', targetRef: 'preset-1' });
  });

  it('leaves a single unresolvable decision unchanged instead of dropping the batch', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            decisions: [{
              tabRef: 'tab-42', kind: 'existing_group', targetRef: 'group-missing',
              suggestedName: null, suggestedDescription: null, confidence: 0.9, reason: 'Unknown group',
            }],
          }),
        }],
      }],
    }), { status: 200 });
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    const decisions = await classifier.classify(request);

    expect(decisions[0]).toMatchObject({ kind: 'no_change', targetRef: null });
  });

  it('invokes a Worker-compatible fetch function without binding the classifier as receiver', async () => {
    const fetcher = function (this: unknown): Promise<Response> {
      if (this instanceof OpenAiClassifier) throw new Error('illegal_invocation');
      return Promise.resolve(new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({
          decisions: [{ tabRef: 'tab-42', kind: 'no_change', targetRef: null,
            suggestedName: null, suggestedDescription: null, confidence: 0.5, reason: 'No change' }],
        }) }] }],
      }), { status: 200 }));
    } as typeof fetch;
    const classifier = new OpenAiClassifier(endpoint, fetcher);

    await expect(classifier.classify(request)).resolves.toHaveLength(1);
  });

  it('rejects missing and duplicate decisions atomically', async () => {
    const twoTabRequest: ClassificationRequest = {
      ...request,
      tabs: [
        ...request.tabs,
        { ref: 'tab-43', title: 'Second', hostname: 'second.example.test', currentGroup: null },
      ],
    };
    const decision = {
      tabRef: 'tab-42',
      kind: 'no_change',
      targetRef: null,
      suggestedName: null,
      suggestedDescription: null,
      confidence: 0.5,
      reason: 'No change',
    };
    for (const decisions of [
      [decision],
      [decision, { ...decision, tabRef: 'tab-43' }, decision],
    ]) {
      const fetcher: typeof fetch = async () => new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: JSON.stringify({ decisions }) }] }],
      }), { status: 200 });

      await expect(
        new OpenAiClassifier(endpoint, fetcher).classify(twoTabRequest),
      ).rejects.toThrow('classification_invalid_response');
    }
  });

  it('ends classification after the configured timeout', async () => {
    const fetcher: typeof fetch = async () => new Promise<Response>(() => undefined);
    const classifier = new OpenAiClassifier(endpoint, fetcher, 1);

    await expect(classifier.classify(request)).rejects.toThrow('classification_request_timeout');
  });

  it('ends classification when the response body does not complete', async () => {
    let aborted = false;
    const response = {
      ok: true,
      json: async () => new Promise<unknown>(() => undefined),
    } as Response;
    const fetcher: typeof fetch = async (_input, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return response;
    };
    const classifier = new OpenAiClassifier(endpoint, fetcher, 1);

    await expect(classifier.classify(request)).rejects.toThrow('classification_request_timeout');
    expect(aborted).toBe(true);
  });
});

describe('classificationTimeoutMs', () => {
  it('never drops below the fixed-overhead floor for a small chunk', () => {
    expect(classificationTimeoutMs(0)).toBe(CLASSIFICATION_TIMEOUT_FLOOR_MS);
    expect(classificationTimeoutMs(1)).toBe(CLASSIFICATION_TIMEOUT_FLOOR_MS);
  });

  it('scales with the tab count once the per-tab budget exceeds the floor', () => {
    const many = 20;
    expect(classificationTimeoutMs(many)).toBe(many * CLASSIFICATION_TIMEOUT_PER_TAB_MS);
    expect(classificationTimeoutMs(many)).toBeGreaterThan(classificationTimeoutMs(many - 1));
  });

  it('covers the slowest observed chunk of five tabs', () => {
    // Measured worst case for a five-tab chunk was 11.2s against the company gateway.
    expect(classificationTimeoutMs(5)).toBeGreaterThan(11_200);
  });
});

describe('OpenAiClassifier timeout derivation', () => {
  it('derives the request timeout from the tab count when none is configured', async () => {
    vi.useFakeTimers();
    try {
      const fetcher: typeof fetch = () => new Promise<Response>(() => undefined);
      const classifier = new OpenAiClassifier(endpoint, fetcher);
      let settled = false;
      void classifier.classify(request).catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(classificationTimeoutMs(request.tabs.length) - 10);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpenAiTaxonomyPlanner', () => {
  const taxonomyRequest = {
    locale: 'en' as const,
    tabs: request.tabs.map(({ ref, title, hostname }) => ({ ref, title, hostname })),
    groups: request.groups,
    presets: request.presets,
    maxTitles: 10,
  };

  function respondWith(titles: string[]): typeof fetch {
    return async () => new Response(
      JSON.stringify({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify({ groups: titles.map((title) => ({ title })) }),
          }],
        }],
      }),
      { status: 200 },
    );
  }

  it('maps a planned title back to an existing group or preset reference', async () => {
    const planner = new OpenAiTaxonomyPlanner(endpoint, respondWith(['Apollo', 'Reading']),
    );

    const entries = await planner.plan(taxonomyRequest);

    expect(entries).toEqual([
      { title: 'Apollo', kind: 'existing_group', ref: 'group-7' },
      { title: 'Reading', kind: 'new_group', ref: null },
    ]);
  });

  it('matches a planned title case-insensitively and drops blank titles', async () => {
    const planner = new OpenAiTaxonomyPlanner(endpoint, respondWith(['  apollo  ', '   ', 'Reading']),
    );

    const entries = await planner.plan(taxonomyRequest);

    expect(entries).toEqual([
      { title: 'Apollo', kind: 'existing_group', ref: 'group-7' },
      { title: 'Reading', kind: 'new_group', ref: null },
    ]);
  });

  it('sends only titles and hostnames so the plan stays small', async () => {
    let body: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return respondWith(['Apollo'])(_input, init);
    };
    const planner = new OpenAiTaxonomyPlanner(endpoint, fetcher);

    await planner.plan(taxonomyRequest);

    const serialized = JSON.stringify(body);
    expect(serialized).toContain('billing.example.test');
    expect(serialized).not.toContain('currentGroup');
    expect(serialized).not.toContain('https://');
  });

  it('caps the plan so a runaway list cannot fan out into many groups', async () => {
    const titles = Array.from({ length: 18 }, (_, index) => `Group ${index}`);
    const planner = new OpenAiTaxonomyPlanner(endpoint, respondWith(titles),
    );

    const entries = await planner.plan(taxonomyRequest);

    expect(entries).toHaveLength(TAXONOMY_MAX_TITLES);
    expect(entries[0]?.title).toBe('Group 0');
  });

  it('honours a tighter cap so a small window cannot fan out like a large one', async () => {
    const titles = Array.from({ length: 18 }, (_, index) => `Group ${index}`);
    let instructions = '';
    const fetcher: typeof fetch = async (input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === 'object' && parsed !== null && 'instructions' in parsed) {
        instructions = String((parsed as { instructions: unknown }).instructions);
      }
      return respondWith(titles)(input, init);
    };
    const planner = new OpenAiTaxonomyPlanner(endpoint, fetcher);

    const entries = await planner.plan({ ...taxonomyRequest, maxTitles: 3 });

    expect(entries).toHaveLength(3);
    expect(instructions).toContain('at most 3 titles');
    expect(instructions).toContain('Prefer fewer, broader groups');
  });

  it('instructs the model to keep every new title in one language', async () => {
    let instructions = '';
    const fetcher: typeof fetch = async (input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === 'object' && parsed !== null && 'instructions' in parsed) {
        instructions = String((parsed as { instructions: unknown }).instructions);
      }
      return respondWith(['Apollo'])(input, init);
    };
    const planner = new OpenAiTaxonomyPlanner(endpoint, fetcher);

    await planner.plan(taxonomyRequest);

    expect(instructions).toContain('translation');
    expect(instructions).toContain('language');
  });

  it('fails loudly when the plan cannot be parsed', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ output: [] }), { status: 200 });
    const planner = new OpenAiTaxonomyPlanner(endpoint, fetcher);

    await expect(planner.plan(taxonomyRequest)).rejects.toThrow('taxonomy_invalid_response');
  });
});
