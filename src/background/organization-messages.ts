import type { OrganizationService, OrganizationState } from './organization-service';
import type { GroupColor, PresetDraft } from './preset-store';
import type { ApplyResult, SynchronizationProposal } from './synchronization-service';

export type OrganizationRequest =
  | { type: 'organization/get' }
  | { type: 'presets/create'; draft: PresetDraft }
  | { type: 'presets/update'; id: string; draft: PresetDraft }
  | { type: 'presets/delete'; id: string }
  | { type: 'presets/reorder'; orderedIds: string[] }
  | { type: 'locks/lock-active' }
  | { type: 'locks/lock'; tabId: number }
  | { type: 'locks/unlock'; tabId: number }
  | { type: 'locks/unlock-and-analyze'; tabId: number }
  | { type: 'automatic/retry'; tabId: number }
  | { type: 'sync/review'; scope: 'all' | 'current' }
  | { type: 'sync/latest' }
  | { type: 'sync/apply'; proposalId: string; selectedTabIds: number[] };

export interface OrganizationResponse {
  ok: boolean;
  state?: OrganizationState;
  proposal?: SynchronizationProposal;
  reviewing?: boolean;
  applyResult?: ApplyResult;
  error?: 'invalid_request' | 'operation_failed';
}

export type OrganizationMessageHandler = (message: unknown) => Promise<OrganizationResponse>;

export function createOrganizationMessageHandler(service: OrganizationService): OrganizationMessageHandler {
  return async (message) => {
    if (!isOrganizationRequest(message)) return { ok: false, error: 'invalid_request' };
    try {
      switch (message.type) {
        case 'organization/get':
          return { ok: true, state: await service.getState() };
        case 'presets/create':
          return { ok: true, state: await service.createPreset(message.draft) };
        case 'presets/update':
          return { ok: true, state: await service.updatePreset(message.id, message.draft) };
        case 'presets/delete':
          return { ok: true, state: await service.deletePreset(message.id) };
        case 'presets/reorder':
          return { ok: true, state: await service.reorderPresets(message.orderedIds) };
        case 'locks/lock-active':
          return { ok: true, state: await service.lockActiveTab() };
        case 'locks/lock':
          return { ok: true, state: await service.lockTab(message.tabId) };
        case 'locks/unlock':
          return { ok: true, state: await service.unlockTab(message.tabId) };
        case 'locks/unlock-and-analyze':
          return { ok: true, state: await service.unlockAndAnalyze(message.tabId) };
        case 'automatic/retry':
          return { ok: true, state: await service.retryFirstPage(message.tabId) };
        case 'sync/review':
          return { ok: true, proposal: await service.review(message.scope) };
        case 'sync/latest': {
          const proposal = await service.latestProposal();
          // A popup that opens mid-run finds no proposal yet, which is why the answer also carries
          // whether one is still being produced. An absent proposal is valid, so `ok` stays true.
          const reviewing = service.isReviewing();
          return proposal === null ? { ok: true, reviewing } : { ok: true, proposal, reviewing };
        }
        case 'sync/apply':
          return { ok: true, applyResult: await service.apply(message.proposalId, message.selectedTabIds) };
      }
    } catch {
      return { ok: false, error: 'operation_failed' };
    }
  };
}

function isOrganizationRequest(value: unknown): value is OrganizationRequest {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'organization/get':
    case 'locks/lock-active':
    case 'sync/latest':
      return true;
    case 'presets/create':
      return isPresetDraft(value.draft);
    case 'presets/update':
      return typeof value.id === 'string' && isPresetDraft(value.draft);
    case 'presets/delete':
      return typeof value.id === 'string';
    case 'presets/reorder':
      return Array.isArray(value.orderedIds) &&
        value.orderedIds.every((id) => typeof id === 'string');
    case 'locks/unlock':
    case 'locks/lock':
    case 'locks/unlock-and-analyze':
    case 'automatic/retry':
      return typeof value.tabId === 'number';
    case 'sync/review':
      return value.scope === 'all' || value.scope === 'current';
    case 'sync/apply':
      return typeof value.proposalId === 'string' &&
        Array.isArray(value.selectedTabIds) && value.selectedTabIds.every((id) => typeof id === 'number');
    default:
      return false;
  }
}

function isPresetDraft(value: unknown): value is PresetDraft {
  return isRecord(value) && typeof value.name === 'string' &&
    typeof value.description === 'string' && Array.isArray(value.cues) &&
    value.cues.every((cue) => typeof cue === 'string') && isGroupColor(value.color);
}

function isGroupColor(value: unknown): value is GroupColor {
  return value === 'grey' || value === 'blue' || value === 'red' || value === 'yellow' ||
    value === 'green' || value === 'pink' || value === 'purple' || value === 'cyan' || value === 'orange';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
