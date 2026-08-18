import type { LocalStorageArea } from './settings-service';

export type GroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange';

export interface PresetDraft {
  name: string;
  description: string;
  cues: string[];
  color: GroupColor;
}

export interface Preset extends PresetDraft {
  id: string;
}

export class PresetValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class PresetStore {
  private storageMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalStorageArea,
    private readonly createId: () => string,
  ) {}

  async list(): Promise<Preset[]> {
    const values = await this.storage.get(['presets']);
    return parsePresets(values.presets);
  }

  async create(draft: PresetDraft): Promise<Preset> {
    const normalized = validateDraft(draft);
    return this.mutate(async (presets) => {
      const preset = { id: this.createId(), ...normalized };
      await this.storage.set({ presets: [...presets, preset] });
      return preset;
    });
  }

  async update(id: string, draft: PresetDraft): Promise<Preset> {
    const normalized = validateDraft(draft);
    return this.mutate(async (presets) => {
      const index = presets.findIndex((preset) => preset.id === id);
      if (index < 0) {
        throw new PresetValidationError('preset_not_found');
      }
      const updated = { id, ...normalized };
      presets[index] = updated;
      await this.storage.set({ presets });
      return updated;
    });
  }

  /**
   * Rewrites the stored order of the presets.
   *
   * The list has always been ordered; nothing read that order until groups started being placed by
   * it. Ids missing from the request keep their relative order at the end, so a reorder racing with
   * a create cannot drop the new preset.
   */
  async reorder(orderedIds: readonly string[]): Promise<Preset[]> {
    return this.mutate(async (presets) => {
      const seen = new Set<string>();
      const ordered: Preset[] = [];
      for (const id of orderedIds) {
        const preset = presets.find((candidate) => candidate.id === id);
        if (preset === undefined || seen.has(id)) continue;
        seen.add(id);
        ordered.push(preset);
      }
      const next = [...ordered, ...presets.filter((preset) => !seen.has(preset.id))];
      await this.storage.set({ presets: next });
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.mutate(async (presets) => {
      const next = presets.filter((preset) => preset.id !== id);
      if (next.length === presets.length) {
        return false;
      }
      await this.storage.set({ presets: next });
      return true;
    });
  }

  private async mutate<T>(change: (presets: Preset[]) => Promise<T>): Promise<T> {
    const mutation = this.storageMutation.then(async () => change(await this.list()));
    this.storageMutation = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

const GROUP_COLORS: readonly GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === 'string' && GROUP_COLORS.includes(value as GroupColor);
}

function validateDraft(draft: PresetDraft): PresetDraft {
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (name.length === 0) {
    throw new PresetValidationError('name_required');
  }
  if (description.length === 0) {
    throw new PresetValidationError('description_required');
  }
  if (!isGroupColor(draft.color)) {
    throw new PresetValidationError('invalid_color');
  }
  return {
    name,
    description,
    cues: draft.cues.map((cue) => cue.trim()).filter((cue) => cue.length > 0),
    color: draft.color,
  };
}

function parsePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPreset);
}

function isPreset(value: unknown): value is Preset {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    Array.isArray(candidate.cues) &&
    candidate.cues.every((cue) => typeof cue === 'string') &&
    isGroupColor(candidate.color)
  );
}
