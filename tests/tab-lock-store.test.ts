import { describe, expect, it } from 'vitest';

import { TabLockStore } from '../src/background/tab-lock-store';
import type { LocalStorageArea, StoredValues } from '../src/background/settings-service';

class MemorySessionStorage implements LocalStorageArea {
  readonly values: StoredValues = {};
  setCalls = 0;

  async get(keys: readonly string[]): Promise<StoredValues> {
    return Object.fromEntries(
      keys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  async set(items: StoredValues): Promise<void> {
    this.setCalls += 1;
    Object.assign(this.values, items);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      delete this.values[key];
    }
  }
}

describe('TabLockStore', () => {
  it('keeps a tab locked across navigation and service reconstruction', async () => {
    const storage = new MemorySessionStorage();
    const store = new TabLockStore(storage, () => 1_700_000_000_000);
    await store.lock(42);

    await store.recordNavigation(42);
    const restartedStore = new TabLockStore(storage, () => 1_700_000_000_100);

    await expect(restartedStore.list()).resolves.toEqual([
      {
        tabId: 42,
        lockedAt: 1_700_000_000_000,
        changed: true,
      },
    ]);
    expect(JSON.stringify(storage.values)).not.toContain('alpha.example.test');
    expect(JSON.stringify(storage.values)).not.toContain('beta.example.test');
  });

  it('excludes locked tabs before request data is selected', async () => {
    const store = new TabLockStore(new MemorySessionStorage(), () => 100);
    await store.lock(2);
    const tabs = [
      { tabId: 1, title: 'Visible', hostname: 'visible.example.test' },
      { tabId: 2, title: 'Secret', hostname: 'locked.example.test' },
    ];

    const eligible = await store.excludeLocked(tabs);

    expect(eligible).toEqual([tabs[0]]);
    expect(JSON.stringify(eligible)).not.toContain('Secret');
  });

  it('removes locks on unlock and tab close', async () => {
    const store = new TabLockStore(new MemorySessionStorage(), () => 100);
    await store.lock(1);
    await store.lock(2);

    await expect(store.unlock(1)).resolves.toBe(true);
    await store.removeClosedTab(2);

    await expect(store.list()).resolves.toEqual([]);
  });

  it('does not restore a lock when navigation recording overlaps unlock', async () => {
    const store = new TabLockStore(new MemorySessionStorage(), () => 100);
    await store.lock(1);

    await Promise.all([store.recordNavigation(1), store.unlock(1)]);

    await expect(store.list()).resolves.toEqual([]);
  });

  it('does not write when navigation cannot change lock state', async () => {
    const storage = new MemorySessionStorage();
    const store = new TabLockStore(storage, () => 100);

    await store.recordNavigation(99);
    expect(storage.setCalls).toBe(0);

    await store.lock(1);
    storage.setCalls = 0;
    await store.recordNavigation(1);
    await store.recordNavigation(1);

    expect(storage.setCalls).toBe(1);
  });

  it('drops legacy URL fingerprints while reading session records', async () => {
    const storage = new MemorySessionStorage();
    storage.values.tabLocks = [{
      tabId: 9,
      lockedAt: 100,
      urlFingerprint: 'legacy-value',
      changed: false,
    }];

    await expect(new TabLockStore(storage, () => 200).list()).resolves.toEqual([
      { tabId: 9, lockedAt: 100, changed: false },
    ]);
    expect(storage.values.tabLocks).toEqual([
      { tabId: 9, lockedAt: 100, changed: false },
    ]);
  });
});
