import type { OrganizationState } from '../background/organization-service';
import type { OrganizationRequest, OrganizationResponse } from '../background/organization-messages';
import type { PresetDraft } from '../background/preset-store';
import type { SynchronizationProposal } from '../background/synchronization-service';

export interface OrganizationClient {
  getState(): Promise<OrganizationState>;
  createPreset(draft: PresetDraft): Promise<OrganizationState>;
  updatePreset(id: string, draft: PresetDraft): Promise<OrganizationState>;
  deletePreset(id: string): Promise<OrganizationState>;
  lockActiveTab(): Promise<OrganizationState>;
  lockTab(tabId: number): Promise<OrganizationState>;
  unlockTab(tabId: number): Promise<OrganizationState>;
  unlockAndAnalyze(tabId: number): Promise<OrganizationState>;
  retryFirstPage(tabId: number): Promise<OrganizationState>;
  review(scope: 'all' | 'current'): Promise<SynchronizationProposal>;
  latestProposal(): Promise<SynchronizationProposal | null>;
  apply(proposalId: string, selectedTabIds: number[]): Promise<{ applied: number; skipped: number }>;
  undo(operationId: string): Promise<OrganizationState>;
}

export type OrganizationRuntimeMessenger = (request: OrganizationRequest) => Promise<unknown>;

export class RuntimeOrganizationClient implements OrganizationClient {
  constructor(private readonly sendMessage: OrganizationRuntimeMessenger) {}

  getState() { return this.requestState({ type: 'organization/get' }); }
  createPreset(draft: PresetDraft) { return this.requestState({ type: 'presets/create', draft }); }
  updatePreset(id: string, draft: PresetDraft) { return this.requestState({ type: 'presets/update', id, draft }); }
  deletePreset(id: string) { return this.requestState({ type: 'presets/delete', id }); }
  lockActiveTab() { return this.requestState({ type: 'locks/lock-active' }); }
  lockTab(tabId: number) { return this.requestState({ type: 'locks/lock', tabId }); }
  unlockTab(tabId: number) { return this.requestState({ type: 'locks/unlock', tabId }); }
  unlockAndAnalyze(tabId: number) { return this.requestState({ type: 'locks/unlock-and-analyze', tabId }); }
  retryFirstPage(tabId: number) { return this.requestState({ type: 'automatic/retry', tabId }); }
  undo(operationId: string) { return this.requestState({ type: 'history/undo', operationId }); }

  async review(scope: 'all' | 'current'): Promise<SynchronizationProposal> {
    const response = await this.request({ type: 'sync/review', scope });
    if (!isSynchronizationProposal(response.proposal)) throw new Error('organization_request_failed');
    return response.proposal;
  }

  // A review that is still awaiting a decision outlives the popup, so the UI asks for it on load.
  async latestProposal(): Promise<SynchronizationProposal | null> {
    const response = await this.request({ type: 'sync/latest' });
    if (response.proposal === undefined) return null;
    if (!isSynchronizationProposal(response.proposal)) throw new Error('organization_request_failed');
    return response.proposal;
  }

  async apply(proposalId: string, selectedTabIds: number[]) {
    const response = await this.request({ type: 'sync/apply', proposalId, selectedTabIds });
    if (!isApplyResult(response.applyResult)) throw new Error('organization_request_failed');
    return response.applyResult;
  }

  private async requestState(request: OrganizationRequest): Promise<OrganizationState> {
    const response = await this.request(request);
    if (!isOrganizationState(response.state)) throw new Error('organization_request_failed');
    return response.state;
  }

  private async request(request: OrganizationRequest): Promise<OrganizationResponse> {
    const response = await this.sendMessage(request);
    if (!isRecord(response) || response.ok !== true) throw new Error('organization_request_failed');
    return response as unknown as OrganizationResponse;
  }
}

function isOrganizationState(value: unknown): value is OrganizationState {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.presets) && value.presets.every(isPreset) &&
    Array.isArray(value.locks) && value.locks.every(isLock) &&
    Array.isArray(value.history) && value.history.every(isHistoryOperation) &&
    Array.isArray(value.failedTabIds) && value.failedTabIds.every(isNumber) &&
    Array.isArray(value.tabSummaries) && value.tabSummaries.every(isTabSummary)
  );
}

function isSynchronizationProposal(value: unknown): value is SynchronizationProposal {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.scope === 'all' || value.scope === 'current') &&
    Array.isArray(value.changes) && value.changes.every(isSynchronizationChange) &&
    typeof value.unchangedCount === 'number' && typeof value.failedTabCount === 'number';
}

function isSynchronizationChange(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.target)) return false;
  return typeof value.tabId === 'number' && typeof value.windowId === 'number' &&
    typeof value.title === 'string' && typeof value.hostname === 'string' &&
    typeof value.currentGroupId === 'number' && typeof value.confidence === 'number' &&
    typeof value.reason === 'string' && typeof value.selected === 'boolean' &&
    (value.blockedReason === null || value.blockedReason === 'split_view' ||
      value.blockedReason === 'split_view_conflict') &&
    (value.splitViewId === null || typeof value.splitViewId === 'number') &&
    (value.currentGroup === null || isGroupDescriptor(value.currentGroup)) &&
    (value.target.kind === 'existing_group' || value.target.kind === 'preset' ||
      value.target.kind === 'new_group') &&
    (value.target.ref === null || typeof value.target.ref === 'string') &&
    (value.target.groupId === null || typeof value.target.groupId === 'number') &&
    typeof value.target.title === 'string' && isGroupColor(value.target.color) &&
    (value.target.description === null || typeof value.target.description === 'string');
}

function isApplyResult(value: unknown): value is { applied: number; skipped: number } {
  return isRecord(value) && typeof value.applied === 'number' && typeof value.skipped === 'number';
}

function isPreset(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.description === 'string' && Array.isArray(value.cues) &&
    value.cues.every((cue) => typeof cue === 'string') && isGroupColor(value.color);
}

function isLock(value: unknown): boolean {
  return isRecord(value) && typeof value.tabId === 'number' &&
    typeof value.lockedAt === 'number' && typeof value.changed === 'boolean';
}

function isHistoryOperation(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' &&
    (value.kind === 'automatic' || value.kind === 'sync') &&
    typeof value.createdAt === 'number' &&
    (value.undoneAt === null || typeof value.undoneAt === 'number') &&
    Array.isArray(value.tabs) && value.tabs.every((tab) => isRecord(tab) &&
      typeof tab.tabId === 'number' && typeof tab.windowId === 'number' &&
      (tab.group === null || isGroupDescriptor(tab.group)));
}

function isGroupDescriptor(value: unknown): boolean {
  return isRecord(value) && typeof value.title === 'string' && isGroupColor(value.color);
}

function isGroupColor(value: unknown): boolean {
  return value === 'grey' || value === 'blue' || value === 'red' || value === 'yellow' ||
    value === 'green' || value === 'pink' || value === 'purple' || value === 'cyan' ||
    value === 'orange';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isTabSummary(value: unknown): boolean {
  return isRecord(value) && typeof value.tabId === 'number' &&
    typeof value.title === 'string' && typeof value.hostname === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
