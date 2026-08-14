import { describe, expect, it } from 'vitest';

import {
  PresetStore,
  PresetValidationError,
  type PresetDraft,
} from '../src/background/preset-store';
import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';

class MemoryStorage implements LocalStorageArea {
  readonly values: StoredValues = {};

  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(
      keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  async set(items: StoredValues): Promise<void> {
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

const validDraft: PresetDraft = {
  name: 'Apollo',
  description: 'Internal billing platform',
  cues: ['APOLLO-', 'billing.example.test'],
  color: 'blue',
};

describe('PresetStore', () => {
  it('persists a stable preset without creating a Chrome tab group', async () => {
    const storage = new MemoryStorage();
    const store = new PresetStore(storage, () => 'preset-1');

    const created = await store.create(validDraft);
    const restartedStore = new PresetStore(storage, () => 'unused');

    expect(created).toEqual({ id: 'preset-1', ...validDraft });
    await expect(restartedStore.list()).resolves.toEqual([created]);
    expect(Object.keys(storage.values)).toEqual(['presets']);
  });

  it('updates and deletes a preset by stable ID', async () => {
    const storage = new MemoryStorage();
    const store = new PresetStore(storage, () => 'preset-1');
    await store.create(validDraft);

    const updated = await store.update('preset-1', {
      ...validDraft,
      name: 'Apollo Next',
      color: 'purple',
    });

    expect(updated.name).toBe('Apollo Next');
    expect(updated.id).toBe('preset-1');
    await expect(store.delete('preset-1')).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('preserves presets created concurrently', async () => {
    const storage = new MemoryStorage();
    let nextId = 1;
    const store = new PresetStore(storage, () => `preset-${nextId++}`);

    await Promise.all([
      store.create(validDraft),
      store.create({ ...validDraft, name: 'Hermes' }),
    ]);

    await expect(store.list()).resolves.toMatchObject([
      { id: 'preset-1', name: 'Apollo' },
      { id: 'preset-2', name: 'Hermes' },
    ]);
  });

  it.each([
    { draft: { ...validDraft, name: '  ' }, code: 'name_required' },
    { draft: { ...validDraft, description: '' }, code: 'description_required' },
    { draft: { ...validDraft, color: 'black' }, code: 'invalid_color' },
  ])('rejects invalid preset data with $code', async ({ draft, code }) => {
    const store = new PresetStore(new MemoryStorage(), () => 'preset-1');

    await expect(store.create(draft as PresetDraft)).rejects.toMatchObject({ code });
    await expect(store.list()).resolves.toEqual([]);
    expect(PresetValidationError).toBeDefined();
  });
});
