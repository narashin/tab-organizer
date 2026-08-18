import { detachFetch } from '../../shared/fetcher';
import {
  buildClassificationInstructions,
  buildTaxonomyInstructions,
  classificationTimeoutMs,
  decisionSchema,
  isRecord,
  resolveTaxonomy,
  taxonomySchema,
  taxonomyTimeoutMs,
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

export class OpenAiClassifier implements Classifier {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly endpoint: ProviderEndpoint,
    fetcher: typeof fetch = fetch,
    private readonly configuredTimeoutMs?: number,
  ) {
    this.fetcher = detachFetch(fetcher);
  }

  async classify(request: ClassificationRequest): Promise<ClassificationDecision[]> {
    const requestTimeoutMs = this.configuredTimeoutMs ?? classificationTimeoutMs(request.tabs.length);
    const requestController = new AbortController();
    const response = await withTimeout((signal) => this.fetcher(
      `${this.endpoint.baseUrl}/responses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.endpoint.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.endpoint.model,
          store: false,
          instructions: buildClassificationInstructions(request.approvedGroupTitles),
          input: JSON.stringify(request),
          text: {
            format: {
              type: 'json_schema',
              name: 'tab_classification',
              strict: true,
              schema: decisionSchema,
            },
          },
        }),
        signal,
      },
    ), requestTimeoutMs, requestController);

    if (!response.ok) {
      throw new Error('classification_request_failed');
    }

    let payload: unknown;
    try {
      payload = await withTimeout(
        () => response.json(),
        requestTimeoutMs,
        requestController,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'classification_request_timeout') {
        throw error;
      }
      throw new Error('classification_invalid_response');
    }
    const outputText = extractOutputText(payload);
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

export class OpenAiTaxonomyPlanner implements TaxonomyPlanner {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly endpoint: ProviderEndpoint,
    fetcher: typeof fetch = fetch,
    private readonly configuredTimeoutMs?: number,
  ) {
    this.fetcher = detachFetch(fetcher);
  }

  async plan(request: TaxonomyRequest): Promise<TaxonomyEntry[]> {
    const requestController = new AbortController();
    const requestTimeoutMs = this.configuredTimeoutMs ?? taxonomyTimeoutMs(request.tabs.length);
    const response = await withTimeout((signal) => this.fetcher(
      `${this.endpoint.baseUrl}/responses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.endpoint.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.endpoint.model,
          store: false,
          instructions: buildTaxonomyInstructions(request.maxTitles),
          input: JSON.stringify(request),
          text: {
            format: {
              type: 'json_schema',
              name: 'tab_taxonomy',
              strict: true,
              schema: taxonomySchema,
            },
          },
        }),
        signal,
      },
    ), requestTimeoutMs, requestController);

    if (!response.ok) {
      throw new Error('taxonomy_request_failed');
    }

    let payload: unknown;
    try {
      payload = await withTimeout(
        () => response.json(),
        requestTimeoutMs,
        requestController,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'classification_request_timeout') {
        throw error;
      }
      throw new Error('taxonomy_invalid_response');
    }

    const outputText = extractOutputText(payload);
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

function extractOutputText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    return null;
  }
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return null;
}
