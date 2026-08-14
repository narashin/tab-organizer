import type { GroupColor, Preset } from '../preset-store';
import type { SupportedLocale } from '../../shared/localization';

export interface ClassificationTab {
  ref: string;
  title: string;
  hostname: string;
  currentGroup: { ref: string; title: string; color: GroupColor } | null;
}

export interface ClassificationGroup {
  ref: string;
  title: string;
  color: GroupColor;
}

export interface ClassificationRequest {
  mode: 'automatic' | 'synchronization';
  locale: SupportedLocale;
  tabs: ClassificationTab[];
  groups: ClassificationGroup[];
  presets: Preset[];
  // Chunks cannot see each other, so a shared title list keeps them from inventing rival names.
  approvedGroupTitles?: string[];
}

export interface TaxonomyTab {
  ref: string;
  title: string;
  hostname: string;
}

export interface TaxonomyRequest {
  locale: SupportedLocale;
  tabs: TaxonomyTab[];
  groups: ClassificationGroup[];
  presets: Preset[];
  // Derived from the tab count so a small window cannot be split into as many groups as a large one.
  maxTitles: number;
}

export interface TaxonomyEntry {
  title: string;
  kind: 'existing_group' | 'preset' | 'new_group';
  ref: string | null;
}

export interface TaxonomyPlanner {
  plan(request: TaxonomyRequest): Promise<TaxonomyEntry[]>;
}

/**
 * Endpoint credentials as a named record, shared by every provider adapter.
 *
 * These were positional strings, which made `(apiKey, model, baseUrl)` silently swappable: sending
 * the model name as the host still type-checks and still passes every stubbed-fetch test.
 */
export interface ProviderEndpoint {
  apiKey: string;
  model: string;
  baseUrl: string;
}

// A decision costs roughly 55 output tokens and the slowest observed gateway throughput was
// 30 tokens per second. Raising this floor to 20s made a hundred-tab review slower, not more
// reliable: a stalled request burnt the whole budget before retrying. Fail fast and let the
// chunk retry find a healthier connection.
export const CLASSIFICATION_TIMEOUT_PER_TAB_MS = 2_500;
export const CLASSIFICATION_TIMEOUT_FLOOR_MS = 12_000;

export function classificationTimeoutMs(tabCount: number): number {
  return Math.max(CLASSIFICATION_TIMEOUT_FLOOR_MS, tabCount * CLASSIFICATION_TIMEOUT_PER_TAB_MS);
}

// The plan returns at most ten short titles, so its cost is prefill-bound rather than output-bound.
export const TAXONOMY_TIMEOUT_MS = 8_000;

export type DecisionKind = 'existing_group' | 'preset' | 'new_group' | 'no_change';

export interface ClassificationDecision {
  tabRef: string;
  kind: DecisionKind;
  targetRef: string | null;
  suggestedName: string | null;
  suggestedDescription: string | null;
  confidence: number;
  reason: string;
}

export interface Classifier {
  classify(request: ClassificationRequest): Promise<ClassificationDecision[]>;
}

export function resolveTaxonomy(payload: unknown, request: TaxonomyRequest): TaxonomyEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.groups)) {
    throw new Error('taxonomy_invalid_response');
  }
  const entries: TaxonomyEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of payload.groups) {
    if (!isRecord(candidate) || typeof candidate.title !== 'string') {
      throw new Error('taxonomy_invalid_response');
    }
    const title = candidate.title.trim();
    if (title.length === 0) continue;
    const normalized = title.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const group = request.groups.find((item) => item.title.trim().toLowerCase() === normalized);
    if (group !== undefined) {
      entries.push({ title: group.title, kind: 'existing_group', ref: group.ref });
      continue;
    }
    const preset = request.presets.find((item) => item.name.trim().toLowerCase() === normalized);
    if (preset !== undefined) {
      entries.push({ title: preset.name, kind: 'preset', ref: preset.id });
      continue;
    }
    entries.push({ title, kind: 'new_group', ref: null });
  }
  return entries.slice(0, Math.max(1, Math.min(TAXONOMY_MAX_TITLES, request.maxTitles)));
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  controller = new AbortController(),
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error('classification_request_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

// The synchronization pipeline does not deduplicate new_group titles against the supplied
// groups and presets, so an unguided model creates duplicate Chrome groups.
const CLASSIFICATION_INSTRUCTIONS = [
  'Classify each tab using only the supplied title, hostname, current group, groups, and presets.',
  'Return exactly one decision per tab, and prefer what already exists over creating something new.',
  'Pick the kind in this order:',
  '1. no_change when the tab already sits in a group that still fits it.',
  '2. existing_group when one of the supplied groups fits the tab.',
  '3. preset when no supplied group fits but a preset describes the tab.',
  '4. new_group only when none of the above fits.',
  'Identify a target by reference, never by name: targetRef must be the ref of a supplied group or',
  'the id of a supplied preset. Leave suggestedName and suggestedDescription null unless the kind is',
  'new_group.',
  'A new_group title must not copy or closely resemble the title of a supplied group or preset.',
  'Prefer no_change over a weak match: move a tab only when the target clearly fits it.',
  'Set confidence below 0.5 when more than one target could hold the tab.',
  'Write every reason in the language named by the locale field of the input.',
  'Never infer or return private data.',
].join('\n');

// The plan is the only thing keeping independent chunks from inventing rival names, so a list that
// carries both a word and its translation defeats the whole pass: downstream merging is exact-match.
export const TAXONOMY_MAX_TITLES = 10;

export function buildTaxonomyInstructions(maxTitles: number): string {
  const cap = Math.max(1, Math.min(TAXONOMY_MAX_TITLES, maxTitles));
  return [
  'Propose the smallest set of tab group titles that covers every supplied tab.',
  'Reuse the exact title of a supplied group or preset wherever it fits, and add a new title only',
  'when no supplied title fits.',
  `Return at most ${cap} titles. Prefer fewer, broader groups over many narrow ones.`,
  'One concept gets exactly one title. Never return two titles that mean the same thing, including',
  'a translation, an abbreviation, or a longer phrase built around another title in the list.',
  'Write each new title in the single language that best fits the tabs it covers. Different titles',
  'may use different languages, but one title must never mix languages within itself.',
  ].join('\n');
}

export const taxonomySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
    },
  },
} as const;

export function buildClassificationInstructions(approvedGroupTitles: string[] | undefined): string {
  const titles = (approvedGroupTitles ?? []).filter((title) => title.trim().length > 0);
  if (titles.length === 0) {
    return CLASSIFICATION_INSTRUCTIONS;
  }
  return [
    CLASSIFICATION_INSTRUCTIONS,
    `A new_group title must be exactly one of these approved titles: ${titles.join(', ')}.`,
    'Never invent a title outside that list.',
  ].join('\n');
}

export const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'tabRef',
          'kind',
          'targetRef',
          'suggestedName',
          'suggestedDescription',
          'confidence',
          'reason',
        ],
        properties: {
          tabRef: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['existing_group', 'preset', 'new_group', 'no_change'],
          },
          targetRef: { type: ['string', 'null'] },
          suggestedName: { type: ['string', 'null'] },
          suggestedDescription: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export function validateDecisions(
  payload: unknown,
  request: ClassificationRequest,
): ClassificationDecision[] {
  if (!isRecord(payload) || !Array.isArray(payload.decisions)) {
    throw new Error('classification_invalid_response');
  }
  const tabRefs = new Set(request.tabs.map((tab) => tab.ref));
  const groupRefs = new Set(request.groups.map((group) => group.ref));
  const presetRefs = new Set(request.presets.map((preset) => preset.id));
  const seen = new Set<string>();
  const decisions: ClassificationDecision[] = [];

  for (const candidate of payload.decisions) {
    if (!isDecision(candidate) || !tabRefs.has(candidate.tabRef) || seen.has(candidate.tabRef)) {
      throw new Error('classification_invalid_response');
    }
    seen.add(candidate.tabRef);
    decisions.push(resolveDecision(candidate, request));
  }

  if (seen.size !== tabRefs.size) {
    throw new Error('classification_invalid_response');
  }
  return decisions;
}

/**
 * Turns one raw decision into an executable one, degrading it rather than failing its batch.
 *
 * Models name a target far more often than they reference it, so a `preset` decision commonly
 * arrives with a null `targetRef` and the preset name in `suggestedName`. That is recoverable, and
 * discarding it would take every other tab in the same chunk down with it. Anything still
 * unresolvable becomes no_change, which leaves that one tab where the user already had it.
 */
function resolveDecision(
  candidate: ClassificationDecision,
  request: ClassificationRequest,
): ClassificationDecision {
  const unchanged: ClassificationDecision = {
    ...candidate,
    kind: 'no_change',
    targetRef: null,
    suggestedName: null,
    suggestedDescription: null,
  };
  const named = candidate.suggestedName?.trim().toLowerCase() ?? '';

  if (candidate.kind === 'existing_group') {
    const byRef = request.groups.find((group) => group.ref === candidate.targetRef);
    const target = byRef ?? (named === ''
      ? undefined
      : request.groups.find((group) => group.title.trim().toLowerCase() === named));
    return target === undefined
      ? unchanged
      : { ...candidate, targetRef: target.ref, suggestedName: null, suggestedDescription: null };
  }

  if (candidate.kind === 'preset') {
    const byId = request.presets.find((preset) => preset.id === candidate.targetRef);
    const target = byId ?? (named === ''
      ? undefined
      : request.presets.find((preset) => preset.name.trim().toLowerCase() === named));
    return target === undefined
      ? unchanged
      : { ...candidate, targetRef: target.id, suggestedName: null, suggestedDescription: null };
  }

  if (candidate.kind === 'new_group') {
    return candidate.suggestedName === null || candidate.suggestedName.trim().length === 0
      ? unchanged
      : { ...candidate, targetRef: null };
  }

  return unchanged;
}

function isDecision(value: unknown): value is ClassificationDecision {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.tabRef === 'string' &&
    isDecisionKind(value.kind) &&
    (typeof value.targetRef === 'string' || value.targetRef === null) &&
    (typeof value.suggestedName === 'string' || value.suggestedName === null) &&
    (typeof value.suggestedDescription === 'string' || value.suggestedDescription === null) &&
    typeof value.confidence === 'number' &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    typeof value.reason === 'string'
  );
}

function isDecisionKind(value: unknown): value is DecisionKind {
  return (
    value === 'existing_group' ||
    value === 'preset' ||
    value === 'new_group' ||
    value === 'no_change'
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
