import { describe, expect, it } from 'vitest';

import { planTabOrder, type OrderedGroup, type OrderedTab } from '../src/background/tab-order';

function tab(partial: Partial<OrderedTab> & { tabId: number; index: number }): OrderedTab {
  return { pinned: false, groupId: -1, title: `Tab ${partial.tabId}`, ...partial };
}

/** Replays a plan against a list of tab ids, so assertions read as the strip the user would see. */
function apply(tabs: OrderedTab[], groups: OrderedGroup[]): string[] {
  const strip = [...tabs].sort((left, right) => left.index - right.index);
  for (const step of planTabOrder(tabs, groups)) {
    if (step.kind === 'group') {
      const members = strip.filter((item) => item.groupId === step.groupId);
      for (const member of members) strip.splice(strip.indexOf(member), 1);
      strip.splice(step.index < 0 ? strip.length : step.index, 0, ...members);
      continue;
    }
    const moved = strip.find((item) => item.tabId === step.tabId);
    if (moved === undefined) continue;
    strip.splice(strip.indexOf(moved), 1);
    strip.splice(step.index < 0 ? strip.length : step.index, 0, moved);
  }
  return strip.map((item) => item.title);
}

describe('planTabOrder', () => {
  it('puts groups in title order ahead of the loose tabs, each sorted inside', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, title: 'zebra notes' }),
      tab({ tabId: 2, index: 1, groupId: 7, title: 'Docs beta' }),
      tab({ tabId: 3, index: 2, groupId: 9, title: 'API two' }),
      tab({ tabId: 4, index: 3, groupId: 7, title: 'Docs alpha' }),
      tab({ tabId: 5, index: 4, title: 'apple notes' }),
      tab({ tabId: 6, index: 5, groupId: 9, title: 'API one' }),
    ];
    const groups: OrderedGroup[] = [
      { groupId: 7, title: 'Docs' },
      { groupId: 9, title: 'API' },
    ];

    expect(apply(tabs, groups)).toEqual([
      'API one', 'API two', 'Docs alpha', 'Docs beta', 'apple notes', 'zebra notes',
    ]);
  });

  it('leaves pinned tabs where Chrome keeps them, at the front', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, pinned: true, title: 'zzz pinned' }),
      tab({ tabId: 2, index: 1, groupId: 4, title: 'Beta' }),
      tab({ tabId: 3, index: 2, groupId: 4, title: 'Alpha' }),
    ];

    expect(apply(tabs, [{ groupId: 4, title: 'Work' }])).toEqual(['zzz pinned', 'Alpha', 'Beta']);
  });

  it('refuses to reorder a window holding Split View tabs', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, title: 'zebra' }),
      tab({ tabId: 2, index: 1, title: 'apple', splitViewId: 3 }),
    ];

    // Sorting moves everything around the pair, which is still a move.
    expect(planTabOrder(tabs, [])).toEqual([]);
  });

  it('sorts case and digits the way a reader expects', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, title: 'report 10' }),
      tab({ tabId: 2, index: 1, title: 'Report 2' }),
      tab({ tabId: 3, index: 2, title: 'apple' }),
    ];

    expect(apply(tabs, [])).toEqual(['apple', 'Report 2', 'report 10']);
  });

  it('plans nothing for a window with only pinned tabs', () => {
    expect(planTabOrder([tab({ tabId: 1, index: 0, pinned: true })], [])).toEqual([]);
  });

  it('ignores a group whose tabs are all gone', () => {
    const tabs = [tab({ tabId: 1, index: 0, title: 'only' })];

    expect(planTabOrder(tabs, [{ groupId: 5, title: 'Empty' }]))
      .toEqual([{ kind: 'tab', tabId: 1, index: -1 }]);
  });
});
