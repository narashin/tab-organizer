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

const GEMINI_TYPES: Record<string, string> = {
  object: 'OBJECT',
  array: 'ARRAY',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
};

/**
 * Rewrites the shared JSON Schema into the subset Gemini accepts as a `responseSchema`.
 *
 * Type names are upper case there, a nullable field is a flag rather than a type union, and
 * keywords it does not model (`additionalProperties`, numeric bounds) are rejected outright rather
 * than ignored. Dropping them costs nothing: the shared validator re-checks every field anyway.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;

  const converted: Record<string, unknown> = {};
  const type = schema.type;

  if (Array.isArray(type)) {
    const concrete = type.find((entry) => entry !== 'null');
    if (typeof concrete === 'string') converted.type = GEMINI_TYPES[concrete] ?? concrete.toUpperCase();
    if (type.includes('null')) converted.nullable = true;
  } else if (typeof type === 'string') {
    converted.type = GEMINI_TYPES[type] ?? type.toUpperCase();
  }

  if (Array.isArray(schema.enum)) converted.enum = schema.enum;
  if (Array.isArray(schema.required)) converted.required = schema.required;
  if (isRecord(schema.properties)) {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
    // Gemini emits properties in the order given rather than the order declared in the schema.
    converted.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.items !== undefined) converted.items = toGeminiSchema(schema.items);

  return converted;
}

function requestUrl(endpoint: ProviderEndpoint): string {
  // Gemini names the model in the path, so a model with a slash or a space would silently retarget
  // the request. Encoding keeps a bad value inside the path segment it belongs to.
  return `${endpoint.baseUrl}/models/${encodeURIComponent(endpoint.model)}:generateContent`;
}

function headers(endpoint: ProviderEndpoint): Record<string, string> {
  // The key rides in a header, never the query string, where proxies and logs would keep a copy.
  return { 'x-goog-api-key': endpoint.apiKey, 'Content-Type': 'application/json' };
}

function requestBody(instructions: string, input: unknown, schema: unknown): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  });
}

/** Joins the text parts of the first candidate, which is where generateContent puts the JSON. */
export function extractGeminiText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    return null;
  }
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter((part): part is { text: string } => isRecord(part) && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text.length > 0) return text;
  }
  return null;
}

export class GeminiClassifier implements Classifier {
  constructor(
    private readonly endpoint: ProviderEndpoint,
    private readonly fetcher: typeof fetch = fetch,
    private readonly configuredTimeoutMs?: number,
  ) {}

  async classify(request: ClassificationRequest): Promise<ClassificationDecision[]> {
    const requestTimeoutMs = this.configuredTimeoutMs ?? classificationTimeoutMs(request.tabs.length);
    const requestController = new AbortController();
    const response = await withTimeout((signal) => this.fetcher(
      requestUrl(this.endpoint),
      {
        method: 'POST',
        headers: headers(this.endpoint),
        body: requestBody(
          buildClassificationInstructions(request.approvedGroupTitles),
          request,
          decisionSchema,
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

    const outputText = extractGeminiText(payload);
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

export class GeminiTaxonomyPlanner implements TaxonomyPlanner {
  constructor(
    private readonly endpoint: ProviderEndpoint,
    private readonly fetcher: typeof fetch = fetch,
    private readonly requestTimeoutMs = TAXONOMY_TIMEOUT_MS,
  ) {}

  async plan(request: TaxonomyRequest): Promise<TaxonomyEntry[]> {
    const requestController = new AbortController();
    const response = await withTimeout((signal) => this.fetcher(
      requestUrl(this.endpoint),
      {
        method: 'POST',
        headers: headers(this.endpoint),
        body: requestBody(buildTaxonomyInstructions(request.maxTitles), request, taxonomySchema),
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

    const outputText = extractGeminiText(payload);
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
