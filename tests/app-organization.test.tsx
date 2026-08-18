import type { GroupingGranularity } from '../src/shared/grouping';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { OrganizationState } from '../src/background/organization-service';
import type { PresetDraft } from '../src/background/preset-store';
import type { SettingsState } from '../src/background/settings-service';
import type {
  ApplyResult,
  ReviewScope,
  SynchronizationProposal,
} from '../src/background/synchronization-service';
import {
  translations,
  withProviderName,
  type LocaleSelection,
  type SupportedLocale,
} from '../src/shared/localization';
import {
  RuntimeOrganizationClient,
  type OrganizationClient,
} from '../src/ui/organization-client';
import type { SettingsClient } from '../src/ui/settings-client';
import type { Provider } from '../src/shared/provider';
import { App } from '../src/ui/App';

class ReadySettingsClient implements SettingsClient {
  state: SettingsState = {
    localeSelection: 'en', locale: 'en', provider: 'openai',
    providerKeys: { openai: true, anthropic: false, google: false },
    apiKeyStatus: 'valid', apiKeyConfigured: true,
    organizationEnabled: true, model: 'gpt-5.6', baseUrl: 'https://api.openai.com/v1',
    baseUrlIsDefault: true, groupingGranularity: 'balanced', sendPathEnabled: false,
    sortTabsEnabled: false, firstPageEnabled: true,
  };
  async getState() { return this.state; }
  async setLocale(localeSelection: LocaleSelection) { this.state = { ...this.state, localeSelection, locale: localeSelection === 'system' ? 'en' : localeSelection }; return this.state; }
  async saveAndTestApiKey() { return this.state; }
  async deleteApiKey() { return this.state; }
  async setProvider(provider: Provider) { this.state = { ...this.state, provider }; return this.state; }
  async setModel(model: string) { this.state = { ...this.state, model }; return this.state; }
  async setBaseUrl(baseUrl: string) { this.state = { ...this.state, baseUrl, baseUrlIsDefault: false }; return this.state; }
  async setGroupingGranularity(groupingGranularity: GroupingGranularity) { this.state = { ...this.state, groupingGranularity }; return this.state; }
  async setSendPathEnabled(sendPathEnabled: boolean) { this.state = { ...this.state, sendPathEnabled }; return this.state; }
  async setSortTabsEnabled(sortTabsEnabled: boolean) { this.state = { ...this.state, sortTabsEnabled }; return this.state; }
  async setFirstPageEnabled(firstPageEnabled: boolean) { this.state = { ...this.state, firstPageEnabled }; return this.state; }
}

class MemoryOrganizationClient implements OrganizationClient {
  state: OrganizationState = { presets: [], locks: [], failedTabIds: [], tabSummaries: [] };
  applied: number[] = [];
  applyResult = { applied: 0, skipped: 0, sortOutcome: null as null | 'move_refused' | 'unavailable' };
  lockedIds: number[] = [];
  retriedIds: number[] = [];
  applyCalls = 0;
  // What the background still holds from an earlier review, as the popup would find it on reopen.
  pendingProposal: SynchronizationProposal | null = null;
  // Whether a run started before this popup opened is still going.
  reviewing = false;
  async getState() { return this.state; }
  async reviewStatus() { return { proposal: this.pendingProposal, reviewing: this.reviewing }; }
  async createPreset(draft: PresetDraft) {
    this.state = { ...this.state, presets: [...this.state.presets, { id: 'preset-1', ...draft }] };
    return this.state;
  }
  async updatePreset(id: string, draft: PresetDraft) {
    this.state = { ...this.state, presets: this.state.presets.map((preset) => preset.id === id ? { id, ...draft } : preset) };
    return this.state;
  }
  async deletePreset(id: string) {
    this.state = { ...this.state, presets: this.state.presets.filter((preset) => preset.id !== id) };
    return this.state;
  }
  async reorderPresets(orderedIds: readonly string[]) {
    const ordered = orderedIds
      .map((id) => this.state.presets.find((preset) => preset.id === id))
      .filter((preset): preset is OrganizationState['presets'][number] => preset !== undefined);
    this.state = {
      ...this.state,
      presets: [...ordered, ...this.state.presets.filter((preset) => !orderedIds.includes(preset.id))],
    };
    return this.state;
  }
  async lockActiveTab() { return this.state; }
  async lockTab(tabId: number) {
    this.lockedIds.push(tabId);
    // The real service answers with the lock in place, which is what the review list reads.
    this.state = { ...this.state, locks: [...this.state.locks, { tabId, lockedAt: 1, changed: false }] };
    return this.state;
  }
  async unlockTab(tabId: number) {
    this.state = { ...this.state, locks: this.state.locks.filter((lock) => lock.tabId !== tabId) };
    return this.state;
  }
  async unlockAndAnalyze() { return this.state; }
  async retryFirstPage(tabId: number) {
    this.retriedIds.push(tabId);
    this.state = { ...this.state, failedTabIds: this.state.failedTabIds.filter((id) => id !== tabId) };
    return this.state;
  }
  reviewedScopes: ReviewScope[] = [];
  async review(scope: ReviewScope = 'current'): Promise<SynchronizationProposal> {
    this.reviewedScopes.push(scope);
    return {
      id: 'proposal-1', scope, unchangedCount: 2, failedTabs: [], skippedGroups: [], planFailureReason: null,
      changes: [
        { tabId: 1, windowId: 3, title: 'Normal', hostname: 'normal.test', currentGroup: null, currentGroupId: -1,
          target: { kind: 'new_group', ref: null, groupId: null, title: 'Work', color: 'grey', description: 'Work tabs' },
          confidence: 0.8, reason: 'Related', selected: true, blockedReason: null, splitViewId: null },
        { tabId: 2, windowId: 3, title: 'Split', hostname: 'split.test', currentGroup: null, currentGroupId: -1,
          target: { kind: 'new_group', ref: null, groupId: null, title: 'Other', color: 'grey', description: null },
          confidence: 0.8, reason: 'Related', selected: false, blockedReason: 'split_view', splitViewId: 9 },
      ],
    };
  }
  async apply(_proposalId: string, selectedTabIds: number[]) {
    this.applyCalls += 1;
    this.applied = selectedTabIds;
    return this.applyResult.applied === 0 && this.applyResult.skipped === 0
      ? { applied: selectedTabIds.length, skipped: 0, sortOutcome: this.applyResult.sortOutcome }
      : this.applyResult;
  }
}

class GroupProposalOrganizationClient extends MemoryOrganizationClient {
  override async review(): Promise<SynchronizationProposal> {
    const proposal = await super.review();
    const first = proposal.changes[0];
    if (first === undefined) return proposal;
    return {
      ...proposal,
      changes: [first, { ...first, tabId: 7, title: 'Second normal', hostname: 'second.test' }],
    };
  }
}

class ConflictOrganizationClient extends MemoryOrganizationClient {
  override async review(): Promise<SynchronizationProposal> {
    return {
      id: 'conflict', scope: 'current', unchangedCount: 0, failedTabs: [], skippedGroups: [], planFailureReason: null,
      changes: [
        { tabId: 11, windowId: 3, title: 'Split left', hostname: 'left.test', currentGroup: null,
          currentGroupId: -1, target: { kind: 'new_group', ref: null, groupId: null, title: 'Left group', color: 'grey', description: null },
          confidence: 0.9, reason: 'Left', selected: false, blockedReason: 'split_view_conflict', splitViewId: 8 },
        { tabId: 12, windowId: 3, title: 'Split right', hostname: 'right.test', currentGroup: null,
          currentGroupId: -1, target: { kind: 'new_group', ref: null, groupId: null, title: 'Right group', color: 'grey', description: null },
          confidence: 0.9, reason: 'Right', selected: false, blockedReason: 'split_view_conflict', splitViewId: 8 },
      ],
    };
  }
}

class PartialSelectionOrganizationClient extends MemoryOrganizationClient {
  override async review(): Promise<SynchronizationProposal> {
    const proposal = await super.review();
    return {
      ...proposal,
      changes: proposal.changes.map((change) => change.tabId === 2
        ? { ...change, selected: true, blockedReason: null, splitViewId: null }
        : change),
    };
  }
}

const grantAll = { contains: async () => true, request: async () => true };

describe('App organization flows', () => {
  it.each(['en', 'ko', 'ja'] satisfies SupportedLocale[])(
    'renders every section in %s',
    async (locale) => {
      const user = userEvent.setup();
      const settings = new ReadySettingsClient();
      settings.state = {
        ...settings.state,
        localeSelection: locale,
        locale,
      };
      const text = translations[locale];
      render(<App settingsClient={settings} organizationClient={new MemoryOrganizationClient()} permissionBridge={grantAll} />);

      await user.click(await screen.findByRole('button', { name: text.navReview }));
      expect(await screen.findByRole('heading', { name: text.reviewTitle })).toBeVisible();
      await user.click(screen.getByRole('button', { name: text.navPresets }));
      expect(await screen.findByRole('heading', { name: text.presetsTitle })).toBeVisible();
      await user.click(screen.getByRole('button', { name: text.navLocked }));
      // No heading there: the navigation already names the section, so the region carries the label.
      expect(await screen.findByRole('region', { name: text.lockedTitle })).toBeVisible();
      await user.click(screen.getByRole('button', { name: text.navSettings }));
      expect(await screen.findByRole('heading', {
        // The heading names the provider whose key it asks for.
        name: withProviderName(text.connectTitle, text.providerOpenAi),
      })).toBeVisible();
      expect(document.documentElement.lang).toBe(locale);
    },
  );

  it('creates a persistent preset from the Presets section', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new MemoryOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    await user.type(screen.getByLabelText('Name'), 'Apollo');
    await user.type(screen.getByLabelText('Description'), 'Internal billing');
    await user.click(screen.getByRole('button', { name: 'Create preset' }));

    expect(await screen.findByText('Apollo')).toBeVisible();
    expect(screen.getByText('Internal billing')).toBeVisible();
  });

  it('keeps separators the user types in the cue field and submits one cue per entry', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const drafts: PresetDraft[] = [];
    organization.createPreset = async (draft) => { drafts.push(draft); return organization.state; };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));
    await user.type(screen.getByLabelText('Name'), 'Apollo');
    await user.type(screen.getByLabelText('Description'), 'Internal billing');

    const cues = screen.getByLabelText('Text cues, comma separated');
    await user.type(cues, 'billing,');
    expect(cues).toHaveValue('billing,');
    await user.type(cues, ' apollo');
    expect(cues).toHaveValue('billing, apollo');

    await user.click(screen.getByRole('button', { name: 'Create preset' }));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.cues).toEqual(['billing', 'apollo']);
  });

  it('picks a group color from the swatches and reloads it when editing', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));
    await user.type(screen.getByLabelText('Name'), 'Apollo');
    await user.type(screen.getByLabelText('Description'), 'Internal billing');
    await user.type(screen.getByLabelText('Text cues, comma separated'), 'billing, apollo');

    expect(screen.getByRole('radio', { name: 'Grey' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Purple' }));
    expect(screen.getByRole('radio', { name: 'Purple' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create preset' }));

    expect(await screen.findByText('Apollo')).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Grey' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('radio', { name: 'Purple' })).toBeChecked();
    expect(screen.getByLabelText('Text cues, comma separated')).toHaveValue('billing, apollo');
  });

  it('prevents duplicate preset submissions while creation is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let createCalls = 0;
    let resolveCreate: ((state: OrganizationState) => void) | undefined;
    organization.createPreset = async () => {
      createCalls += 1;
      return new Promise<OrganizationState>((resolve) => { resolveCreate = resolve; });
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));
    await user.type(screen.getByLabelText('Name'), 'Apollo');
    await user.type(screen.getByLabelText('Description'), 'Internal billing');
    const create = screen.getByRole('button', { name: 'Create preset' });

    await user.click(create);
    expect(create).toBeDisabled();
    await user.click(create);
    expect(createCalls).toBe(1);

    resolveCreate?.({
      ...organization.state,
      presets: [{
        id: 'preset-1', name: 'Apollo', description: 'Internal billing', cues: [], color: 'grey',
      }],
    });
    expect(await screen.findByText('Apollo')).toBeVisible();
  });

  it('reorders presets from the keyboard, because a drop target cannot be reached without a mouse', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      presets: [
        { id: 'first', name: 'Alfa', description: 'A', cues: [], color: 'blue' },
        { id: 'second', name: 'Zulu', description: 'Z', cues: [], color: 'green' },
      ],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    const grip = screen.getByRole('button', { name: 'Reorder Zulu' });
    grip.focus();
    await user.keyboard('{ArrowUp}');

    expect(organization.state.presets.map((preset) => preset.name)).toEqual(['Zulu', 'Alfa']);

    // The order is what places groups when tabs are sorted, so the list says so.
    expect(screen.getByText(/Groups named by a preset are placed in this order/)).toBeVisible();
  });

  it('refuses to move the first preset above itself', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      presets: [{ id: 'only', name: 'Alfa', description: 'A', cues: [], color: 'blue' }],
    };
    let reorders = 0;
    const reorder = organization.reorderPresets.bind(organization);
    organization.reorderPresets = async (ids) => { reorders += 1; return reorder(ids); };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    screen.getByRole('button', { name: 'Reorder Alfa' }).focus();
    await user.keyboard('{ArrowUp}{ArrowDown}');

    expect(reorders).toBe(0);
  });

  it('updates and deletes a preset from the Presets section', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      presets: [{ id: 'preset-1', name: 'Apollo', description: 'Old', cues: [], color: 'grey' }],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Updated');
    await user.click(screen.getByRole('button', { name: 'Update preset' }));
    expect(await screen.findByText('Updated')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No presets yet.')).toBeVisible();
  });

  it('saves a proposed new group as a persistent preset', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    const workSummary = screen.getByText(/Work \(/);
    await user.click(workSummary);

    const workDetails = workSummary.closest('details');
    if (workDetails === null) throw new Error('work_details_missing');
    await user.click(within(workDetails).getByRole('button', { name: 'Save as preset' }));

    // Saying so is what stops the second click; without it the same preset was created again.
    const saved = await within(workDetails).findByRole('button', { name: 'Saved as preset' });
    expect(saved).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Presets' }));

    expect(await screen.findByText('Work')).toBeVisible();
    expect(screen.getByText('Work tabs')).toBeVisible();
  });

  it('creates one preset however often the group button is pressed', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    const workSummary = screen.getByText(/Work \(/);
    await user.click(workSummary);
    const workDetails = workSummary.closest('details');
    if (workDetails === null) throw new Error('work_details_missing');

    const button = within(workDetails).getByRole('button', { name: 'Save as preset' });
    await user.click(button);
    await user.click(button);
    await user.click(button);

    expect(organization.state.presets).toHaveLength(1);
  });

  it('shows Split View as blocked and applies only selected eligible changes', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));

    const blockedMessage = await screen.findByText(/Split View: keep unchanged/);
    expect(blockedMessage).not.toBeVisible();
    await user.click(screen.getByText(/Other \(/));
    expect(blockedMessage).toBeVisible();
    expect(screen.getByText('Selected changes: 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(organization.applied).toEqual([1]);
  });

  it('removes a deselected proposal from the apply payload', async () => {
    const user = userEvent.setup();
    const organization = new PartialSelectionOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('checkbox', { name: /Normal/ }));

    expect(screen.getByText('Selected changes: 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(organization.applied).toEqual([2]);
  });

  it('reports applied and skipped counts after synchronization', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.applyResult = { applied: 2, skipped: 1, sortOutcome: null };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(await screen.findByText('Applied changes: 2 · Skipped changes: 1')).toBeVisible();
  });

  it('reviews only the active tab when asked, and says so in the scope line', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));

    await user.click(screen.getByRole('button', { name: 'Sync this tab' }));

    // A whole-window run costs a request per five tabs; this asks about one tab.
    expect(organization.reviewedScopes).toEqual(['active']);
    expect(await screen.findByText(/Reviewed: this tab/)).toBeVisible();
  });

  it('says which windows a proposal covered, so a restored one is not mistaken', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const single = await organization.review();
    // What an earlier all-windows run leaves behind: changes from more than one window.
    organization.pendingProposal = {
      ...single,
      scope: 'all',
      changes: single.changes.map((change, index) => ({
        ...change,
        windowId: index === 0 ? 4071 : 3088,
        blockedReason: null,
        splitViewId: null,
      })),
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByText(/Reviewed: every window/)).toBeVisible();
    // The window numbers only make sense once the scope is stated.
    expect(screen.getByText(/Work · Window 1/)).toBeVisible();
    expect(screen.getByText(/Other · Window 2/)).toBeVisible();
  });

  it('names the groups it refused to create and why, instead of only counting unchanged tabs', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const pending = await organization.review();
    organization.pendingProposal = {
      ...pending,
      skippedGroups: [
        { title: 'ForgeHub', tabCount: 3, reason: 'too_few_tabs', minimumTabs: 4 },
        { title: 'Weekly digest', tabCount: 2, reason: 'not_in_plan', minimumTabs: null },
      ],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(await screen.findByText(/Groups left uncreated \(2\)/));

    expect(screen.getByText('ForgeHub · needs 4 tabs, has 3')).toBeVisible();
    expect(
      screen.getByText('Weekly digest · not one of the names planned for this window'),
    ).toBeVisible();
  });

  it('shows progress while a review runs and says the wait does not hold the browser', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const finished = await organization.review();
    let release: (proposal: SynchronizationProposal) => void = () => undefined;
    organization.review = () => new Promise<SynchronizationProposal>((resolve) => { release = resolve; });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Sync ungrouped tabs' }));

    const progress = await screen.findByRole('status', { name: 'Reviewing tabs' });
    expect(within(progress).getByText(/runs in the background/)).toBeVisible();

    release(finished);

    // The progress block gives way to the result rather than lingering.
    expect(await screen.findByText(/Work \(/)).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Reviewing tabs' })).toBeNull();
  });

  it('picks up a run that started before the popup opened, and shows its result when it lands', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const finished = await organization.review();
    // What a popup reopened mid-run finds: no proposal yet, but work in progress.
    organization.reviewing = true;
    let reviews = 0;
    organization.review = async () => { reviews += 1; return finished; };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByRole('status', { name: 'Reviewing tabs' })).toBeVisible();
    // Watching a run is not starting one.
    expect(reviews).toBe(0);

    organization.reviewing = false;
    organization.pendingProposal = finished;

    expect(await screen.findByText(/Work \(/, undefined, { timeout: 4_000 })).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Reviewing tabs' })).toBeNull();
  });

  it('selects and deselects a whole group at once, leaving other groups alone', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new GroupProposalOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    await user.click(await screen.findByText(/Work \(2\)/));

    expect(screen.getByRole('button', { name: 'Apply selected (2)' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Deselect all in Work' }));

    expect(screen.getByRole('button', { name: 'Apply selected (0)' })).toBeDisabled();

    // The control flips, so an accidental rejection costs one click rather than every checkbox.
    await user.click(screen.getByRole('button', { name: 'Select all in Work' }));

    expect(screen.getByRole('button', { name: 'Apply selected (2)' })).toBeEnabled();
  });

  it('names the tabs a review could not classify instead of only counting them', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const pending = await organization.review();
    organization.pendingProposal = {
      ...pending,
      failedTabs: [
        { tabId: 21, title: 'Quarterly report', hostname: 'reports.test' },
        { tabId: 22, title: 'Release checklist', hostname: 'wiki.test' },
      ],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(await screen.findByText('Tabs that could not be reviewed (2)'));

    expect(screen.getByText('Quarterly report')).toBeVisible();
    expect(screen.getByText('reports.test')).toBeVisible();
    expect(screen.getByText('Release checklist')).toBeVisible();
  });

  it('says when the run had no grouping plan, since that is why the groups came out small', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const pending = await organization.review();
    organization.pendingProposal = { ...pending, planFailureReason: 'taxonomy_invalid_response' };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByText(/Reason: taxonomy_invalid_response/)).toBeVisible();
  });

  it('restores a review left pending by an earlier session without running it again', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const pending = await organization.review();
    organization.pendingProposal = pending;
    let reviews = 0;
    organization.review = async () => { reviews += 1; return pending; };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(await screen.findByText(/Work \(/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply selected (1)' })).toBeEnabled();
    expect(reviews).toBe(0);
  });

  it('leaves the review empty when nothing is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    expect(screen.getByText('Run a synchronization to review proposed changes.')).toBeVisible();
  });

  it('labels pending organization data separately from settings loading', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveState: ((state: OrganizationState) => void) | undefined;
    organization.getState = async () => new Promise<OrganizationState>((resolve) => {
      resolveState = resolve;
    });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    expect(screen.getByText('Loading organization data')).toBeVisible();
    resolveState?.(organization.state);
  });

  it('keeps a settings operation notice when organization loading completes', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveState: ((state: OrganizationState) => void) | undefined;
    organization.getState = async () => new Promise<OrganizationState>((resolve) => {
      resolveState = resolve;
    });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    // A working key lands on Review, so the settings controls need one click to reach.
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'Connect OpenAI' });
    await user.click(screen.getByRole('checkbox', {
      name: 'Organize the first page of new tabs automatically',
    }));
    expect(screen.getByText('Operation completed.')).toBeVisible();

    resolveState?.(organization.state);
    await user.click(screen.getByRole('button', { name: 'Presets' }));
    expect(await screen.findByText('No presets yet.')).toBeVisible();
    expect(screen.getByText('Operation completed.')).toBeVisible();
  });

  it('prevents duplicate synchronization reviews while one is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const proposal = await organization.review();
    let resolveReview: ((value: SynchronizationProposal) => void) | undefined;
    let reviewCalls = 0;
    organization.review = async () => {
      reviewCalls += 1;
      return new Promise<SynchronizationProposal>((resolve) => { resolveReview = resolve; });
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const syncCurrent = screen.getByRole('button', { name: 'Sync ungrouped tabs' });

    await user.click(syncCurrent);
    expect(syncCurrent).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Reviewing tabs' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Review tab changes' })).toHaveAttribute('aria-busy', 'true');
    // A second press while the first is in flight must not start another review.
    await user.click(syncCurrent);
    expect(reviewCalls).toBe(1);

    resolveReview?.(proposal);
    // The same banner now states the scope the proposal came from.
    expect(await screen.findByText(/Reviewed: this window · Unchanged tabs: 2/)).toBeVisible();
  });

  it('locks a specific review row without activating the tab', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('button', { name: 'Lock Normal' }));

    expect(organization.lockedIds).toEqual([1]);
    expect(screen.getByText('Selected changes: 0')).toBeVisible();
    expect(await screen.findByText(/Locked, so this run leaves it alone/)).toBeVisible();
    // Re-ticking it would have been silently ignored at apply time, so it cannot be re-ticked.
    expect(screen.getAllByRole('checkbox')[0]).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Lock Normal' })).toBeNull();
  });

  it('rejects every eligible change in a proposed group at once', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new GroupProposalOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));

    expect(screen.getByText('Selected changes: 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Deselect all in Work' }));

    expect(screen.getByText('Selected changes: 0')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply selected (0)' })).toBeDisabled();
  });

  it('numbers windows in review order and never shows a Chrome window ID', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    const single = await organization.review();
    const first = single.changes[0];
    if (first === undefined) throw new Error('fixture_missing_change');
    organization.review = async () => ({
      ...single,
      changes: [
        { ...first, tabId: 21, windowId: 4071, target: { ...first.target, title: 'Work' } },
        { ...first, tabId: 22, windowId: 3088, target: { ...first.target, title: 'Docs' } },
      ],
    });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));

    expect(await screen.findByText('Work · Window 1 (1)')).toBeVisible();
    expect(screen.getByText('Docs · Window 2 (1)')).toBeVisible();
    expect(screen.queryByText(/4071|3088/)).not.toBeInTheDocument();
  });

  it('shows both sides and targets in one Split View conflict', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new ConflictOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));

    const summary = screen.getByText('Split View conflict (2)');
    await user.click(summary);
    expect(screen.getByText('Proposed target: Left group')).toBeVisible();
    expect(screen.getByText('Proposed target: Right group')).toBeVisible();
    // Nothing in a conflicted pair can be selected, so the outcome is stated rather than offered as
    // a control that would do nothing.
    expect(screen.getByText('Keep unchanged')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Deselect all in/ })).toBeNull();
  });

  it('prevents duplicate apply requests while one is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveApply: ((value: ApplyResult) => void) | undefined;
    organization.apply = async () => {
      organization.applyCalls += 1;
      return new Promise((resolve) => { resolveApply = resolve; });
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    const apply = screen.getByRole('button', { name: 'Apply selected (1)' });

    await user.click(apply);
    expect(apply).toBeDisabled();
    await user.click(apply);
    expect(organization.applyCalls).toBe(1);
    resolveApply?.({ applied: 1, skipped: 0, sortOutcome: null });
    expect(await screen.findByText('Applied changes: 1 · Skipped changes: 0')).toBeVisible();
  });

  it('prevents review and proposal edits while apply is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveApply: ((value: ApplyResult) => void) | undefined;
    organization.apply = async () => new Promise((resolve) => { resolveApply = resolve; });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync ungrouped tabs' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(screen.getByRole('button', { name: 'Sync ungrouped tabs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync ungrouped tabs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deselect all in Work' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Normal/ })).toBeDisabled();
    resolveApply?.({ applied: 1, skipped: 0, sortOutcome: null });
    expect(await screen.findByText('Applied changes: 1 · Skipped changes: 0')).toBeVisible();
  });

  it('shows localized inline validation for whitespace-only preset fields', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new MemoryOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));
    await user.type(screen.getByLabelText('Name'), '   ');
    await user.type(screen.getByLabelText('Description'), '   ');

    await user.click(screen.getByRole('button', { name: 'Create preset' }));

    expect(screen.getByText('Enter a preset name.')).toBeVisible();
    expect(screen.getByText('Enter a preset description.')).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows recognizable titles and hostnames for locked and failed tabs', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      locks: [{ tabId: 1, lockedAt: 100, changed: true }],
      failedTabIds: [2],
      tabSummaries: [
        { tabId: 1, title: 'Locked work', hostname: 'locked.test' },
        { tabId: 2, title: 'Failed work', hostname: 'failed.test' },
      ],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);

    await user.click(await screen.findByRole('button', { name: 'Locked' }));
    expect(screen.getByText('Locked work')).toBeVisible();
    expect(screen.getByText('locked.test')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: /Retry Failed work.*failed\.test/ }));
    expect(organization.retriedIds).toEqual([2]);
    expect(screen.queryByRole('heading', { name: 'Failed automatic organization' })).not.toBeInTheDocument();
  });

  it('unlocks a tab from the Locked section', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      locks: [{ tabId: 1, lockedAt: 100, changed: false }],
      tabSummaries: [{ tabId: 1, title: 'Locked work', hostname: 'locked.test' }],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Locked' }));

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Unlock (1)' }));

    expect(await screen.findByText('No locked tabs.')).toBeVisible();
  });

  it('unlocks every selected tab in one action', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      locks: [
        { tabId: 1, lockedAt: 100, changed: false },
        { tabId: 2, lockedAt: 100, changed: true },
        { tabId: 3, lockedAt: 100, changed: false },
      ],
      tabSummaries: [
        { tabId: 1, title: 'First locked', hostname: 'one.test' },
        { tabId: 2, title: 'Second locked', hostname: 'two.test' },
        { tabId: 3, title: 'Third locked', hostname: 'three.test' },
      ],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Locked' }));

    // Clearing a long list one row at a time is what this replaces.
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('Selected changes: 3')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unlock (3)' }));

    expect(await screen.findByText('No locked tabs.')).toBeVisible();
  });

  it('distinguishes organization load failure from an empty state and retries', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let attempts = 0;
    organization.getState = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('storage_unavailable');
      return organization.state;
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Presets' }));

    expect(await screen.findByText('Organization data could not be loaded.')).toBeVisible();
    expect(screen.queryByText('No presets yet.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No presets yet.')).toBeVisible();
    expect(attempts).toBe(2);
  });

  it.each(['all', 'current', 'active', 'ungrouped'] satisfies ReviewScope[])(
    'accepts a proposal reviewed with the %s scope',
    async (scope) => {
      // Twice now a new scope reached the background but not this validator, and every proposal was
      // rejected: the review section looked unreviewed with nothing to explain it.
      const client = new RuntimeOrganizationClient(async () => ({
        ok: true,
        proposal: {
          id: 'proposal-1',
          scope,
          unchangedCount: 0,
          failedTabs: [],
          skippedGroups: [],
          planFailureReason: null,
          changes: [],
        },
      }));

      await expect(client.review(scope)).resolves.toMatchObject({ scope });
    },
  );

  it('accepts a proposal in the shape the background actually sends', async () => {
    // The client validates every proposal, so a field renamed on one side and not the other rejects
    // every review. Only the end-to-end run caught that; this keeps the two shapes tied together.
    const proposal: SynchronizationProposal = {
      id: 'proposal-1',
      scope: 'current',
      unchangedCount: 0,
      failedTabs: [{ tabId: 9, title: 'Unreviewed', hostname: 'slow.test' }],
      skippedGroups: [{ title: 'Reading', tabCount: 1, reason: 'too_few_tabs', minimumTabs: 4 }],
      planFailureReason: null,
      changes: [{
        tabId: 1, windowId: 3, title: 'Normal', hostname: 'normal.test', currentGroup: null,
        currentGroupId: -1, confidence: 0.9, reason: 'Related', selected: true,
        blockedReason: null, splitViewId: null,
        target: {
          kind: 'new_group', ref: null, groupId: null, title: 'Work', color: 'blue',
          description: null,
        },
      }],
    };
    const client = new RuntimeOrganizationClient(async () => ({ ok: true, proposal }));

    await expect(client.review('current')).resolves.toMatchObject({ id: 'proposal-1' });
  });

  it('rejects malformed successful organization responses', async () => {
    const malformed = [
      { action: 'review', response: { ok: true, proposal: { changes: null } } },
      { action: 'state', response: { ok: true, state: { presets: null } } },
      { action: 'apply', response: { ok: true, applyResult: { applied: 'one', skipped: 0 } } },
    ] as const;
    for (const example of malformed) {
      const client = new RuntimeOrganizationClient(async () => example.response);
      const request = example.action === 'review'
        ? client.review('current')
        : example.action === 'state'
          ? client.getState()
          : client.apply('proposal-1', [1]);
      await expect(request).rejects.toThrow('organization_request_failed');
    }
  });
});
