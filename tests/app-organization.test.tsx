import type { GroupingGranularity } from '../src/shared/grouping';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { OrganizationState } from '../src/background/organization-service';
import type { PresetDraft } from '../src/background/preset-store';
import type { SettingsState } from '../src/background/settings-service';
import type { SynchronizationProposal } from '../src/background/synchronization-service';
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
    baseUrlIsDefault: true, groupingGranularity: 'balanced', sendPathEnabled: false, firstPageEnabled: true,
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
  async setFirstPageEnabled(firstPageEnabled: boolean) { this.state = { ...this.state, firstPageEnabled }; return this.state; }
}

class MemoryOrganizationClient implements OrganizationClient {
  state: OrganizationState = { presets: [], locks: [], history: [], failedTabIds: [], tabSummaries: [] };
  applied: number[] = [];
  applyResult = { applied: 0, skipped: 0 };
  undoneIds: string[] = [];
  lockedIds: number[] = [];
  retriedIds: number[] = [];
  applyCalls = 0;
  // What the background still holds from an earlier review, as the popup would find it on reopen.
  pendingProposal: SynchronizationProposal | null = null;
  async getState() { return this.state; }
  async latestProposal() { return this.pendingProposal; }
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
  async lockActiveTab() { return this.state; }
  async lockTab(tabId: number) { this.lockedIds.push(tabId); return this.state; }
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
  async review(): Promise<SynchronizationProposal> {
    return {
      id: 'proposal-1', scope: 'current', unchangedCount: 2, failedTabCount: 0,
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
      ? { applied: selectedTabIds.length, skipped: 0 }
      : this.applyResult;
  }
  async undo(operationId: string) {
    this.undoneIds.push(operationId);
    this.state = {
      ...this.state,
      history: this.state.history.map((operation) => operation.id === operationId
        ? { ...operation, undoneAt: 200 }
        : operation),
    };
    return this.state;
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
      id: 'conflict', scope: 'current', unchangedCount: 0, failedTabCount: 0,
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
      expect(await screen.findByRole('heading', { name: text.lockedTitle })).toBeVisible();
      await user.click(screen.getByRole('button', { name: text.navHistory }));
      expect(await screen.findByRole('heading', { name: text.historyTitle })).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    const workSummary = screen.getByText(/Work \(/);
    await user.click(workSummary);

    const workDetails = workSummary.closest('details');
    if (workDetails === null) throw new Error('work_details_missing');
    await user.click(within(workDetails).getByRole('button', { name: 'Save as preset' }));
    await user.click(screen.getByRole('button', { name: 'Presets' }));

    expect(await screen.findByText('Work')).toBeVisible();
    expect(screen.getByText('Work tabs')).toBeVisible();
  });

  it('shows Split View as blocked and applies only selected eligible changes', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));

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
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('checkbox', { name: /Normal/ }));

    expect(screen.getByText('Selected changes: 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(organization.applied).toEqual([2]);
  });

  it('reports applied and skipped counts after synchronization', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.applyResult = { applied: 2, skipped: 1 };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(await screen.findByText('Applied changes: 2 · Skipped changes: 1')).toBeVisible();
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
    const syncAll = screen.getByRole('button', { name: 'Sync all windows' });
    const syncCurrent = screen.getByRole('button', { name: 'Sync current window' });

    await user.click(syncAll);
    expect(syncAll).toBeDisabled();
    expect(syncCurrent).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Reviewing tabs' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Review tab changes' })).toHaveAttribute('aria-busy', 'true');
    await user.click(syncCurrent);
    expect(reviewCalls).toBe(1);

    resolveReview?.(proposal);
    expect(await screen.findByText('Unchanged tabs: 2')).toBeVisible();
  });

  it('locks a specific review row without activating the tab', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('button', { name: 'Lock Normal' }));

    expect(organization.lockedIds).toEqual([1]);
    expect(screen.getByText('Selected changes: 0')).toBeVisible();
  });

  it('rejects every eligible change in a proposed group at once', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new GroupProposalOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));

    expect(screen.getByText('Selected changes: 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reject group Work' }));

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
    await user.click(screen.getByRole('button', { name: 'Sync all windows' }));

    expect(await screen.findByText('Work · Window 1 (1)')).toBeVisible();
    expect(screen.getByText('Docs · Window 2 (1)')).toBeVisible();
    expect(screen.queryByText(/4071|3088/)).not.toBeInTheDocument();
  });

  it('shows both sides and targets in one Split View conflict', async () => {
    const user = userEvent.setup();
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={new ConflictOrganizationClient()} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));

    const summary = screen.getByText('Split View conflict (2)');
    await user.click(summary);
    expect(screen.getByText('Proposed target: Left group')).toBeVisible();
    expect(screen.getByText('Proposed target: Right group')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep unchanged' })).toBeVisible();
  });

  it('prevents duplicate apply requests while one is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveApply: ((value: { applied: number; skipped: number }) => void) | undefined;
    organization.apply = async () => {
      organization.applyCalls += 1;
      return new Promise((resolve) => { resolveApply = resolve; });
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    const apply = screen.getByRole('button', { name: 'Apply selected (1)' });

    await user.click(apply);
    expect(apply).toBeDisabled();
    await user.click(apply);
    expect(organization.applyCalls).toBe(1);
    resolveApply?.({ applied: 1, skipped: 0 });
    expect(await screen.findByText('Applied changes: 1 · Skipped changes: 0')).toBeVisible();
  });

  it('prevents review and proposal edits while apply is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    let resolveApply: ((value: { applied: number; skipped: number }) => void) | undefined;
    organization.apply = async () => new Promise((resolve) => { resolveApply = resolve; });
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Sync current window' }));
    await user.click(screen.getByText(/Work \(/));

    await user.click(screen.getByRole('button', { name: 'Apply selected (1)' }));

    expect(screen.getByRole('button', { name: 'Sync all windows' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync current window' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject group Work' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Normal/ })).toBeDisabled();
    resolveApply?.({ applied: 1, skipped: 0 });
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

    await user.click(screen.getByRole('button', { name: 'Unlock' }));

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

  it('runs undo from the History button with the selected operation ID', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      history: [{
        id: 'history-1',
        kind: 'sync',
        createdAt: 100,
        tabs: [{ tabId: 1, windowId: 3, group: null }],
        undoneAt: null,
      }],
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'History' }));

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(organization.undoneIds).toEqual(['history-1']);
    expect(await screen.findByRole('button', { name: 'Undone' })).toBeDisabled();
  });

  it('disables repeated undo submission while the operation is pending', async () => {
    const user = userEvent.setup();
    const organization = new MemoryOrganizationClient();
    organization.state = {
      ...organization.state,
      history: [{
        id: 'history-1', kind: 'sync', createdAt: 100,
        tabs: [{ tabId: 1, windowId: 3, group: null }], undoneAt: null,
      }],
    };
    let resolveUndo: ((state: OrganizationState) => void) | undefined;
    organization.undo = async (operationId) => {
      organization.undoneIds.push(operationId);
      return new Promise((resolve) => { resolveUndo = resolve; });
    };
    render(<App settingsClient={new ReadySettingsClient()} organizationClient={organization} permissionBridge={grantAll} />);
    await user.click(await screen.findByRole('button', { name: 'History' }));
    const undo = screen.getByRole('button', { name: 'Undo' });

    await user.click(undo);
    expect(undo).toBeDisabled();
    await user.click(undo);
    expect(organization.undoneIds).toEqual(['history-1']);
    resolveUndo?.({
      ...organization.state,
      history: organization.state.history.map((operation) => ({ ...operation, undoneAt: 200 })),
    });
    expect(await screen.findByRole('button', { name: 'Undone' })).toBeDisabled();
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
