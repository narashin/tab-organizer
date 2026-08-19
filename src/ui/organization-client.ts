import type { OrganizationState } from '../background/organization-service';
import type { OrganizationRequest, OrganizationResponse } from '../background/organization-messages';
import type { PresetDraft } from '../background/preset-store';
import type { ApplyResult, ReviewScope, SynchronizationProposal } from '../background/synchronization-service';

/**
 * What the background has for the review section right now.
 *
 * The two answers arrive together on purpose: asking for the proposal and for progress separately
 * leaves a gap where a run can finish between the calls, and the popup would show neither.
 */
export interface ReviewStatus {
  proposal: SynchronizationProposal | null;
  reviewing: boolean;
}

export interface OrganizationClient {
  getState(): Promise<OrganizationState>;
  createPreset(draft: PresetDraft): Promise<OrganizationState>;
  updatePreset(id: string, draft: PresetDraft): Promise<OrganizationState>;
  deletePreset(id: string): Promise<OrganizationState>;
  reorderPresets(orderedIds: readonly string[]): Promise<OrganizationState>;
  lockActiveTab(): Promise<OrganizationState>;
  lockTab(tabId: number): Promise<OrganizationState>;
  unlockTab(tabId: number): Promise<OrganizationState>;
  unlockAndAnalyze(tabId: number): Promise<OrganizationState>;
  retryFirstPage(tabId: number): Promise<OrganizationState>;
  review(scope: ReviewScope): Promise<SynchronizationProposal>;
  reviewStatus(): Promise<ReviewStatus>;
  /** Reports that this window is showing a finished review, which puts the toolbar badge out. */
  markReviewSeen(): Promise<void>;
  apply(proposalId: string, selectedTabIds: number[]): Promise<ApplyResult>;
}

export type OrganizationRuntimeMessenger = (request: OrganizationRequest) => Promise<unknown>;

export class RuntimeOrganizationClient implements OrganizationClient {
  constructor(private readonly sendMessage: OrganizationRuntimeMessenger) {}

  getState() { return this.requestState({ type: 'organization/get' }); }
  createPreset(draft: PresetDraft) { return this.requestState({ type: 'presets/create', draft }); }
  updatePreset(id: string, draft: PresetDraft) { return this.requestState({ type: 'presets/update', id, draft }); }
  deletePreset(id: string) { return this.requestState({ type: 'presets/delete', id }); }
  reorderPresets(orderedIds: readonly string[]) { return this.requestState({ type: 'presets/reorder', orderedIds: [...orderedIds] }); }
  lockActiveTab() { return this.requestState({ type: 'locks/lock-active' }); }
  lockTab(tabId: number) { return this.requestState({ type: 'locks/lock', tabId }); }
  unlockTab(tabId: number) { return this.requestState({ type: 'locks/unlock', tabId }); }
  unlockAndAnalyze(tabId: number) { return this.requestState({ type: 'locks/unlock-and-analyze', tabId }); }
  retryFirstPage(tabId: number) { return this.requestState({ type: 'automatic/retry', tabId }); }

  async review(scope: ReviewScope): Promise<SynchronizationProposal> {
    const response = await this.request({ type: 'sync/review', scope });
    if (!isSynchronizationProposal(response.proposal)) throw new Error('organization_request_failed');
    return response.proposal;
  }

  // A review outlives the popup, whether it is finished and waiting or still running, so the UI
  // asks for both on load and again while a run is in flight.
  async reviewStatus(): Promise<ReviewStatus> {
    const response = await this.request({ type: 'sync/latest' });
    const reviewing = response.reviewing === true;
    if (response.proposal === undefined) return { proposal: null, reviewing };
    if (!isSynchronizationProposal(response.proposal)) throw new Error('organization_request_failed');
    return { proposal: response.proposal, reviewing };
  }

  async markReviewSeen(): Promise<void> {
    await this.request({ type: 'sync/seen' });
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
    if (!isRecord(response) || response.ok !== true) {
      // The background knows why; carrying it here is what lets the interface say so.
      throw new Error(typeof response === 'object' && response !== null && 'reason' in response &&
        typeof response.reason === 'string' && response.reason.length > 0
        ? response.reason
        : 'organization_request_failed');
    }
    return response as unknown as OrganizationResponse;
  }
}

function isOrganizationState(value: unknown): value is OrganizationState {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.presets) && value.presets.every(isPreset) &&
    Array.isArray(value.locks) && value.locks.every(isLock) &&
    Array.isArray(value.failedTabIds) && value.failedTabIds.every(isNumber) &&
    Array.isArray(value.tabSummaries) && value.tabSummaries.every(isTabSummary)
  );
}

function isSynchronizationProposal(value: unknown): value is SynchronizationProposal {
  return isRecord(value) && typeof value.id === 'string' &&
    isReviewScope(value.scope) &&
    Array.isArray(value.changes) && value.changes.every(isSynchronizationChange) &&
    typeof value.unchangedCount === 'number' &&
    Array.isArray(value.failedTabs) && value.failedTabs.every(isFailedTab);
}

// Kept beside the proposal check on purpose: every time a scope was added and this list was not,
// the popup rejected every proposal and the review section simply looked unreviewed.
function isReviewScope(value: unknown): value is ReviewScope {
  return value === 'all' || value === 'current' || value === 'active' || value === 'ungrouped';
}

function isFailedTab(value: unknown): boolean {
  return isRecord(value) && typeof value.tabId === 'number' && typeof value.title === 'string' &&
    typeof value.hostname === 'string';
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

function isApplyResult(value: unknown): value is ApplyResult {
  return isRecord(value) && typeof value.applied === 'number' &&
    typeof value.skipped === 'number' &&
    (value.sortOutcome === null || value.sortOutcome === 'move_refused' ||
      value.sortOutcome === 'unavailable');
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
