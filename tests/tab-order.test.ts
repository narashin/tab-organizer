import { describe, expect, it } from 'vitest';

import { planTabOrder, type OrderedGroup, type OrderedTab } from '../src/background/tab-order';

function tab(partial: Partial<OrderedTab> & { tabId: number; index: number }): OrderedTab {
  return { pinned: false, groupId: -1, title: `Tab ${partial.tabId}`, ...partial };
}

/** Replays a plan against a list of tab ids, so assertions read as the strip the user would see. */
function apply(tabs: OrderedTab[], groups: OrderedGroup[], presetNames: string[] = []): string[] {
  const strip = [...tabs].sort((left, right) => left.index - right.index);
  for (const step of planTabOrder(tabs, groups, presetNames)) {
    const moved = step.kind === 'group'
      ? strip.filter((item) => item.groupId === step.groupId)
      : step.tabIds.flatMap((tabId) => strip.filter((item) => item.tabId === tabId));
    for (const item of moved) strip.splice(strip.indexOf(item), 1);
    strip.splice(step.index < 0 ? strip.length : step.index, 0, ...moved);
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

  it('places groups a preset named in preset order, ahead of the alphabetical rest', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, groupId: 1, title: 'A note' }),
      tab({ tabId: 2, index: 1, groupId: 2, title: 'B note' }),
      tab({ tabId: 3, index: 2, groupId: 3, title: 'C note' }),
    ];
    const groups: OrderedGroup[] = [
      { groupId: 1, title: 'Alfa' },
      { groupId: 2, title: 'Zulu' },
      { groupId: 3, title: 'Mike' },
    ];

    // Zulu comes first because the user put that preset first; Alfa is not a preset, so it falls
    // behind every preset group and sorts by title with the others.
    expect(apply(tabs, groups, ['Zulu', 'Mike'])).toEqual(['B note', 'C note', 'A note']);
  });

  it('matches a preset to a group by name alone, ignoring case and spacing', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, groupId: 1, title: 'first' }),
      tab({ tabId: 2, index: 1, groupId: 2, title: 'second' }),
    ];
    const groups: OrderedGroup[] = [
      { groupId: 1, title: 'Alfa' },
      { groupId: 2, title: 'zulu' },
    ];

    expect(apply(tabs, groups, ['  ZULU  '])).toEqual(['second', 'first']);
  });

  it('leaves pinned tabs where Chrome keeps them, at the front', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, pinned: true, title: 'zzz pinned' }),
      tab({ tabId: 2, index: 1, groupId: 4, title: 'Beta' }),
      tab({ tabId: 3, index: 2, groupId: 4, title: 'Alpha' }),
    ];

    expect(apply(tabs, [{ groupId: 4, title: 'Work' }])).toEqual(['zzz pinned', 'Alpha', 'Beta']);
  });

  it('keeps a Split View pair together and puts it at the head of its section', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, title: 'apple' }),
      tab({ tabId: 2, index: 1, title: 'zebra left', splitViewId: 3 }),
      tab({ tabId: 3, index: 2, title: 'melon' }),
      tab({ tabId: 4, index: 3, title: 'zebra right', splitViewId: 3 }),
    ];

    // The pair keeps a fixed place instead of being buried wherever its titles happen to sort.
    expect(apply(tabs, [])).toEqual(['zebra left', 'zebra right', 'apple', 'melon']);
  });

  it('moves the two halves of a pair in one step, so nothing can land between them', () => {
    const tabs = [
      tab({ tabId: 1, index: 0, title: 'left', splitViewId: 5 }),
      tab({ tabId: 2, index: 1, title: 'right', splitViewId: 5 }),
    ];

    expect(planTabOrder(tabs, [])).toEqual([{ kind: 'tabs', tabIds: [1, 2], index: -1 }]);
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
      .toEqual([{ kind: 'tabs', tabIds: [1], index: -1 }]);
  });
});
