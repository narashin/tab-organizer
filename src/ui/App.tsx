import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';

import type { OrganizationState } from '../background/organization-service';
import { undoableOperationId } from '../background/history-store';
import type { GroupColor, PresetDraft } from '../background/preset-store';
import type { SettingsState } from '../background/settings-service';
import type { SynchronizationProposal } from '../background/synchronization-service';
import {
  fillPlaceholders,
  translations,
  withProviderName,
  type LocaleSelection,
  type TranslationKey,
} from '../shared/localization';
import { normalizeBaseUrl } from '../shared/base-url';
import type { GroupingGranularity } from '../shared/grouping';
import { PROVIDERS, type Provider } from '../shared/provider';
import { ensureHostAccess, type PermissionBridge } from './host-permissions';
import type { OrganizationClient } from './organization-client';
import {
  clampPopupWidth,
  POPUP_DEFAULT_WIDTH,
  POPUP_KEYBOARD_STEP,
  type PopupWidthStore,
} from './popup-size';
import type { SettingsClient } from './settings-client';

export interface AppProps {
  settingsClient: SettingsClient;
  organizationClient?: OrganizationClient;
  // Required, not optional: this gate is the only thing standing between the key and a host the
  // user never approved, and an omitted prop would silently skip it.
  permissionBridge: PermissionBridge;
  // Which surface renders the app. Only the frame width and the panel shortcut differ.
  shell?: AppShell;
  // Supplied by the popup entry only; the side panel cannot open itself.
  openSidePanel?: () => Promise<void>;
  // Supplied by the popup entry only. The side panel is sized by Chrome, not by the document.
  popupWidthStore?: PopupWidthStore;
}

type AppShell = 'popup' | 'panel';

type Section = 'review' | 'presets' | 'locked' | 'history' | 'settings';

const languageOptions: ReadonlyArray<{ value: LocaleSelection; labelKey: TranslationKey }> = [
  { value: 'system', labelKey: 'languageSystem' },
  { value: 'en', labelKey: 'languageEnglish' },
  { value: 'ko', labelKey: 'languageKorean' },
  { value: 'ja', labelKey: 'languageJapanese' },
];
const groupingOptions: ReadonlyArray<{ value: GroupingGranularity; labelKey: TranslationKey }> = [
  { value: 'broad', labelKey: 'groupingBroad' },
  { value: 'balanced', labelKey: 'groupingBalanced' },
  { value: 'fine', labelKey: 'groupingFine' },
];
const providerOptions: ReadonlyArray<{ value: Provider; labelKey: TranslationKey }> = [
  { value: 'openai', labelKey: 'providerOpenAi' },
  { value: 'anthropic', labelKey: 'providerAnthropic' },
  { value: 'google', labelKey: 'providerGoogle' },
];
const providerKeyLabels: Record<Provider, TranslationKey> = {
  openai: 'providerOpenAi',
  anthropic: 'providerAnthropic',
  google: 'providerGoogle',
};
// Slow enough to be free next to a run that takes tens of seconds, quick enough that the result
// does not sit finished behind a spinner.
const REVIEW_POLL_INTERVAL_MS = 1_500;

const colors: GroupColor[] = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const colorKeys: Record<GroupColor, TranslationKey> = {
  grey: 'colorGrey', blue: 'colorBlue', red: 'colorRed', yellow: 'colorYellow',
  green: 'colorGreen', pink: 'colorPink', purple: 'colorPurple', cyan: 'colorCyan', orange: 'colorOrange',
};

export function App({
  settingsClient,
  organizationClient,
  permissionBridge,
  shell = 'panel',
  openSidePanel,
  popupWidthStore,
}: AppProps) {
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [organization, setOrganization] = useState<OrganizationState | null>(null);
  // Review is the reason the extension is opened, so it is where the interface lands. An install
  // without a working key has nothing to review yet, so that case starts at settings instead.
  const [section, setSection] = useState<Section | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-5.6');
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlError, setBaseUrlError] = useState<'invalid' | 'denied' | null>(null);
  const [isSavingBaseUrl, setIsSavingBaseUrl] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isPresetSubmitting, setIsPresetSubmitting] = useState(false);
  const [undoingOperationId, setUndoingOperationId] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [organizationLoadFailed, setOrganizationLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [proposal, setProposal] = useState<SynchronizationProposal | null>(null);
  const [applyResult, setApplyResult] = useState<{ applied: number; skipped: number } | null>(null);
  const [notice, setNotice] = useState<'success' | 'error' | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetDraft, setPresetDraft] = useState<PresetDraft>({
    name: '', description: '', cues: [], color: 'grey',
  });
  // Held as raw text so a trailing separator survives until the draft is submitted.
  const [cuesText, setCuesText] = useState('');
  const [popupWidth, setPopupWidth] = useState<number>(
    () => clampPopupWidth(popupWidthStore?.read() ?? POPUP_DEFAULT_WIDTH),
  );
  const resizeOrigin = useRef<{ pointerX: number; width: number } | null>(null);
  const [presetErrors, setPresetErrors] = useState({ name: false, description: false });

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    void settingsClient.getState().then((next) => {
      if (!active) return;
      setSettings(next);
      setModel(next.model);
      setBaseUrl(next.baseUrl);
      setSection((current) => current ?? (next.organizationEnabled ? 'review' : 'settings'));
    }).catch(() => { if (active) setLoadFailed(true); });
    if (organizationClient !== undefined) {
      setOrganizationLoadFailed(false);
      void organizationClient.getState().then((next) => {
        if (active) { setOrganization(next); setOrganizationLoadFailed(false); }
      }).catch(() => {
        if (active) setOrganizationLoadFailed(true);
      });
      // Restoring the pending review is best effort: without it the section just looks unreviewed,
      // which is the same state the user would see anyway.
      void organizationClient.reviewStatus().then((status) => {
        if (!active) return;
        if (status.proposal !== null) setProposal(status.proposal);
        // A run started before this popup opened owns the section until it lands.
        if (status.reviewing) setIsReviewing(true);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, [settingsClient, organizationClient, loadAttempt]);

  /**
   * Follows a run this popup is not awaiting itself.
   *
   * The popup that started a review holds its promise and needs nothing here. A popup opened in the
   * middle of one has no promise to hold, so it asks the worker until the answer arrives. Polling,
   * rather than a port, because the worker is free to sleep between requests and a dropped port
   * would leave the section frozen on a spinner.
   */
  useEffect(() => {
    if (!isReviewing || organizationClient === undefined) return undefined;
    let active = true;
    const timer = setInterval(() => {
      void organizationClient.reviewStatus().then((status) => {
        if (!active || status.reviewing) return;
        if (status.proposal !== null) setProposal(status.proposal);
        setIsReviewing(false);
      }).catch(() => {
        // The worker is unreachable, so nothing is going to finish. Stop claiming otherwise.
        if (active) setIsReviewing(false);
      });
    }, REVIEW_POLL_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [isReviewing, organizationClient]);

  // The same rule the background enforces, so the interface cannot offer what would be refused.
  const undoableId = undoableOperationId(organization?.history ?? []);
  const locale = settings?.locale ?? 'en';
  const text = translations[locale];
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const selectedCount = proposal?.changes.filter((change) => change.selected && change.blockedReason === null).length ?? 0;
  const organizationUnavailable = organizationClient !== undefined && organization === null;
  const tabSummaries = new Map(
    (organization?.tabSummaries ?? []).map((summary) => [summary.tabId, summary]),
  );
  // Chrome window IDs are internal counters, so they are numbered by the order they appear in the
  // proposal. A single-window review needs no number at all.
  const windowOrdinals = useMemo(() => {
    const ordinals = new Map<number, number>();
    for (const change of proposal?.changes ?? []) {
      if (!ordinals.has(change.windowId)) ordinals.set(change.windowId, ordinals.size + 1);
    }
    return ordinals;
  }, [proposal]);
  const proposalGroups = useMemo(() => {
    const groups = new Map<string, SynchronizationProposal['changes']>();
    for (const change of proposal?.changes ?? []) {
      if (change.blockedReason === 'split_view_conflict' && change.splitViewId !== null) {
        const key = `${change.windowId}:split-view:${change.splitViewId}`;
        const existing = groups.get(key);
        if (existing === undefined) groups.set(key, [change]);
        else existing.push(change);
        continue;
      }
      const targetIdentity = change.target.groupId ?? change.target.ref ??
        `${change.target.title}:${change.target.color}`;
      const key = `${change.windowId}:${change.target.kind}:${targetIdentity}`;
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, [change]);
      else existing.push(change);
    }
    return [...groups.entries()];
  }, [proposal]);

  // Chrome sizes the popup from its document, so the frame carries the dragged width. Height is left
  // to the content because Chrome refuses to grow a popup vertically. The side panel is sized by the
  // browser chrome and takes no inline size.
  const shellStyle = shell === 'popup' ? { width: `${popupWidth}px` } : undefined;

  if (settings === null) return (
    <main className={`app-shell app-shell--${shell} app-shell--loading`} style={shellStyle}>
      <p role="status">{loadFailed ? text.operationError : text.loading}</p>
      {loadFailed ? (
        <button type="button" className="btn btn--secondary" onClick={() => setLoadAttempt((value) => value + 1)}>
          {text.retry}
        </button>
      ) : null}
    </main>
  );

  const resizePopup = (width: number) => {
    setPopupWidth(clampPopupWidth(width));
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    resizeOrigin.current = { pointerX: event.clientX, width: popupWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = resizeOrigin.current;
    if (origin === null) return;
    resizePopup(origin.width + (event.clientX - origin.pointerX));
  };

  // Written once per gesture rather than on every move, which would be a storage write per pixel.
  const handleResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeOrigin.current === null) return;
    resizeOrigin.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    popupWidthStore?.write(popupWidth);
  };

  const handleResizeKey = (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    const step = event.shiftKey ? POPUP_KEYBOARD_STEP * 5 : POPUP_KEYBOARD_STEP;
    let next = popupWidth;
    if (event.key === 'ArrowLeft') next -= step;
    else if (event.key === 'ArrowRight') next += step;
    else return;
    event.preventDefault();
    resizePopup(next);
    popupWidthStore?.write(clampPopupWidth(next));
  };

  const run = async (operation: () => Promise<void>) => {
    setNotice(null);
    try { await operation(); setNotice('success'); } catch { setNotice('error'); }
  };

  // Submitting the form is the user gesture Chrome needs, so the host prompt runs from here rather
  // than from a later effect. Without access the request cannot leave the browser, and the key would
  // be stored against a verdict that only ever says the connection failed.
  const handleKeySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      if (!(await ensureHostAccess(settings.baseUrl, permissionBridge))) {
        setBaseUrlError('denied');
        setNotice('error');
        return;
      }
      const next = await settingsClient.saveAndTestApiKey(apiKey);
      setApiKey('');
      setSettings(next);
      setNotice('success');
    } catch {
      setNotice('error');
    } finally { setIsSaving(false); }
  };

  // Runs straight from the click so Chrome still sees a user gesture when the dialog is needed.
  const handleBaseUrlSave = async () => {
    if (isSavingBaseUrl) return;
    setBaseUrlError(null);
    if (normalizeBaseUrl(baseUrl) === null) {
      setBaseUrlError('invalid');
      setNotice('error');
      return;
    }
    setIsSavingBaseUrl(true);
    try {
      if (!(await ensureHostAccess(baseUrl, permissionBridge))) {
        setBaseUrlError('denied');
        setNotice('error');
        return;
      }
      await run(async () => {
        const next = await settingsClient.setBaseUrl(baseUrl);
        setSettings(next);
        // Show what was actually stored; the draft may differ by a trailing slash or encoding.
        setBaseUrl(next.baseUrl);
      });
    } finally {
      setIsSavingBaseUrl(false);
    }
  };

  // Switching providers swaps the model and the endpoint underneath, so the drafts follow the
  // stored values instead of carrying the previous provider's text into the new one.
  const handleProviderChange = async (provider: Provider) => {
    setBaseUrlError(null);
    await run(async () => {
      const next = await settingsClient.setProvider(provider);
      setSettings(next);
      setModel(next.model);
      setBaseUrl(next.baseUrl);
    });
  };

  const handleReview = async (scope: 'all' | 'current') => {
    if (organizationClient === undefined || isReviewing || isApplying) return;
    setIsReviewing(true);
    setApplyResult(null);
    try {
      await run(async () => { setProposal(await organizationClient.review(scope)); });
    } finally {
      setIsReviewing(false);
    }
  };

  const handlePresetSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (organizationClient === undefined || isPresetSubmitting) return;
    const nextErrors = {
      name: presetDraft.name.trim().length === 0,
      description: presetDraft.description.trim().length === 0,
    };
    setPresetErrors(nextErrors);
    if (nextErrors.name || nextErrors.description) return;
    setIsPresetSubmitting(true);
    try {
      await run(async () => {
        // The cue list is parsed here rather than on every keystroke: splitting while typing would
        // swallow the separator the user just entered. The store drops the empty entries that a
        // trailing separator leaves behind.
        const draft = { ...presetDraft, cues: cuesText.split(',').map((cue) => cue.trim()) };
        const next = editingPresetId === null
          ? await organizationClient.createPreset(draft)
          : await organizationClient.updatePreset(editingPresetId, draft);
        setOrganization(next);
        setEditingPresetId(null);
        setPresetDraft({ name: '', description: '', cues: [], color: 'grey' });
        setCuesText('');
        setPresetErrors({ name: false, description: false });
      });
    } finally {
      setIsPresetSubmitting(false);
    }
  };

  const handleApply = async () => {
    if (organizationClient === undefined || proposal === null || isApplying || isReviewing) return;
    const appliedProposalId = proposal.id;
    setIsApplying(true);
    try {
      await run(async () => {
        setApplyResult(await organizationClient.apply(
          proposal.id,
          proposal.changes
            .filter((change) => change.selected && change.blockedReason === null)
            .map((change) => change.tabId),
        ));
        setProposal((current) => current?.id === appliedProposalId ? null : current);
        setOrganization(await organizationClient.getState());
      });
    } finally {
      setIsApplying(false);
    }
  };

  const navigation: Array<{ section: Section; key: TranslationKey }> = [
    { section: 'review', key: 'navReview' },
    { section: 'presets', key: 'navPresets' },
    { section: 'locked', key: 'navLocked' },
    { section: 'history', key: 'navHistory' },
    { section: 'settings', key: 'navSettings' },
  ];
  const statusKey: TranslationKey = settings.apiKeyStatus === 'valid' ? 'statusValid'
    : settings.apiKeyStatus === 'invalid' ? 'statusInvalid'
      : settings.apiKeyStatus === 'error' ? 'statusError' : 'statusMissing';
  const providerName = text[providerKeyLabels[settings.provider]];
  const statusTone = settings.apiKeyStatus === 'valid' ? 'success'
    : settings.apiKeyStatus === 'missing' ? 'warning' : 'error';

  return (
    <main className={`app-shell app-shell--${shell}`} style={shellStyle}>
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">T</div>
        <span className="brand-name">{text.appName}</span>
        {shell === 'popup' && openSidePanel !== undefined ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void openSidePanel()}>
            {text.openInPanel}
          </button>
        ) : null}
      </header>

      <nav className="segmented" aria-label={text.appName}>
        {navigation.map((item) => (
          <button
            key={item.section}
            type="button"
            className="segmented__item"
            disabled={item.section !== 'settings' && organizationClient === undefined}
            aria-current={section === item.section ? 'page' : undefined}
            onClick={() => setSection(item.section)}
          >
            {text[item.key]}
          </button>
        ))}
      </nav>

      <div className="app-body">
        {notice !== null ? (
          <p className={`banner banner--${notice === 'success' ? 'success' : 'error'}`} role="status">
            {notice === 'success' ? text.operationSuccess : text.operationError}
          </p>
        ) : null}
        {applyResult !== null ? (
          <p className="banner banner--success" role="status">
            {text.appliedChanges}: {applyResult.applied} · {text.skippedChanges}: {applyResult.skipped}
          </p>
        ) : null}

        {section !== 'settings' && organizationUnavailable ? (
          <section className="card">
            <p role="status">{organizationLoadFailed ? text.organizationLoadError : text.organizationLoading}</p>
            {organizationLoadFailed ? (
              <button type="button" className="btn btn--secondary" onClick={() => setLoadAttempt((value) => value + 1)}>
                {text.retry}
              </button>
            ) : null}
          </section>
        ) : null}

        {section === 'review' && !organizationUnavailable ? (
          <>
            <section className="card" aria-labelledby="review-title" aria-busy={isReviewing}>
              <h1 className="card__title" id="review-title">{text.reviewTitle}</h1>
              {/* One window at a time: a Chrome group cannot span windows, so reviewing every
                  window produced a list of groups the user could not see from where they stood. */}
              <button
                type="button"
                className="btn btn--primary btn--block"
                disabled={!settings.organizationEnabled || isReviewing || isApplying}
                onClick={() => void handleReview('current')}
              >
                {text.syncCurrent}
              </button>
              {isReviewing ? (
                <div className="banner banner--info progress" role="status" aria-label={text.reviewingTabs}>
                  <span className="progress__spinner" aria-hidden="true" />
                  <span className="progress__text">
                    <span>{text.reviewingTabs}</span>
                    {/* The run belongs to the background worker, not to this popup, and its result
                        is stored. Saying so is what makes the wait usable. */}
                    <span className="progress__note">{text.reviewingNotice}</span>
                  </span>
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost btn--block"
                disabled={isReviewing || isApplying}
                onClick={() => void run(async () => {
                  if (organizationClient !== undefined) setOrganization(await organizationClient.lockActiveTab());
                })}
              >
                {text.lockCurrent}
              </button>

              {proposal === null ? <p className="empty">{text.reviewEmpty}</p> : (
                <>
                  {/* A proposal outlives the popup, so a restored list has to say which run made
                      it. Without this an all-windows review reads as a current-window one. */}
                  <p className="banner banner--info">
                    {text.reviewScopeLabel}: {proposal.scope === 'all'
                      ? text.reviewScopeAll
                      : text.reviewScopeCurrent} · {text.unchangedCount}: {proposal.unchangedCount}
                  </p>
                  {proposal.failedTabCount > 0 ? (
                    <p className="banner banner--warning" role="status">
                      {text.failedTabCount}: {proposal.failedTabCount}
                    </p>
                  ) : null}
                  {proposal.planFailureReason === null ? null : (
                    <p className="banner banner--warning" role="status">
                      {text.planFailed}: {proposal.planFailureReason}
                    </p>
                  )}
                  {/* Both refusals end in tabs staying put, and the unchanged count alone reads as
                      "nothing matched" when the truth is a name was rejected or a group was too
                      small to be worth creating. */}
                  {proposal.skippedGroups.length > 0 ? (
                    <details className="group">
                      <summary className="group__summary">
                        <span className="swatch swatch--grey" aria-hidden="true" />
                        <span className="group__label">
                          {`${text.skippedGroupsTitle} (${proposal.skippedGroups.length})`}
                        </span>
                      </summary>
                      <div className="group__body">
                        {proposal.skippedGroups.map((skipped) => (
                          <p
                            key={`${skipped.reason}:${skipped.title}`}
                            className="field__note"
                          >
                            {`${skipped.title} · ${skipped.reason === 'too_few_tabs'
                              ? fillPlaceholders(text.skippedTooFewTabs, {
                                count: skipped.tabCount,
                                minimum: skipped.minimumTabs ?? skipped.tabCount,
                              })
                              : text.skippedNotInPlan}`}
                          </p>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {proposalGroups.map(([key, changes]) => {
                    const firstChange = changes[0];
                    if (firstChange === undefined) return null;
                    const isSplitViewConflict = changes.some((change) => change.blockedReason === 'split_view_conflict');
                    const label = isSplitViewConflict ? text.splitViewConflict : firstChange.target.title;
                    const windowSuffix = windowOrdinals.size > 1
                      ? ` · ${text.windowLabel} ${windowOrdinals.get(firstChange.windowId) ?? 1}`
                      : '';
                    // One text node on purpose: the summary line is asserted as a whole string.
                    const summary = `${label}${windowSuffix} (${changes.length})`;
                    // Blocked rows cannot be selected at all, so they must not decide what the
                    // group-wide control does.
                    const selectable = changes.filter((change) => change.blockedReason === null);
                    const allSelected = selectable.length > 0 &&
                      selectable.every((change) => change.selected);
                    const toggleAll = (selected: boolean) => setProposal({
                      ...proposal,
                      changes: proposal.changes.map((item) => selectable.some((change) => change.tabId === item.tabId)
                        ? { ...item, selected }
                        : item),
                    });
                    return (
                      <details key={key} className="group">
                        <summary className="group__summary">
                          <span className={`swatch swatch--${firstChange.target.color}`} aria-hidden="true" />
                          <span className="group__label">{summary}</span>
                        </summary>
                        <div className="group__body">
                          {/* Rejecting a group of twenty by unticking twenty boxes is what this
                              replaces, and it reads the current state so it can also put them back. */}
                          {selectable.length > 0 ? (
                            <div className="group__actions">
                              <button
                                type="button"
                                className="btn btn--soft btn--sm"
                                disabled={isReviewing || isApplying}
                                onClick={() => toggleAll(!allSelected)}
                              >
                                {fillPlaceholders(allSelected ? text.deselectAll : text.selectAll, {
                                  group: firstChange.target.title,
                                })}
                              </button>
                            </div>
                          ) : null}
                          {changes.map((change) => (
                            <div key={change.tabId} className="tab-entry">
                              <div className="tab-row">
                                <label className="check-row">
                                  <input
                                    type="checkbox"
                                    checked={change.selected}
                                    disabled={change.blockedReason !== null || isReviewing || isApplying}
                                    onChange={(event) => setProposal({
                                      ...proposal,
                                      changes: proposal.changes.map((item) => item.tabId === change.tabId
                                        ? { ...item, selected: event.currentTarget.checked }
                                        : item),
                                    })}
                                  />
                                  <span className="row__main">
                                    <span className="row__title">{change.title}</span>
                                    {/* The model's confidence used to sit here. It never changed
                                        what anyone did with the row, so it was noise beside the
                                        one fact that identifies the tab. */}
                                    <span className="row__meta">{change.hostname}</span>
                                  </span>
                                </label>
                                {/* One repeated action per row, so it is drawn rather than spelled out.
                                    The tab it acts on lives in the accessible name instead. */}
                                {change.blockedReason === null ? (
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--icon"
                                    aria-label={`${text.lockTab} ${change.title}`}
                                    title={text.lockTab}
                                    disabled={isReviewing || isApplying}
                                    onClick={() => void run(async () => {
                                      if (organizationClient === undefined) return;
                                      setOrganization(await organizationClient.lockTab(change.tabId));
                                      setProposal({
                                        ...proposal,
                                        changes: proposal.changes.map((item) => item.tabId === change.tabId
                                          ? { ...item, selected: false }
                                          : item),
                                      });
                                    })}
                                  >
                                    <LockIcon />
                                  </button>
                                ) : null}
                              </div>
                              {isSplitViewConflict ? (
                                <p className="field__note">{text.proposedTarget}: {change.target.title}</p>
                              ) : null}
                              {change.blockedReason !== null ? (
                                <p className="field__note">{text.splitViewBlocked}</p>
                              ) : null}
                            </div>
                          ))}

                          {/* A conflicted Split View pair has nothing selectable, so the group-wide
                              toggle above is absent and this states the outcome instead. */}
                          {isSplitViewConflict ? (
                            <p className="field__note">{text.keepUnchanged}</p>
                          ) : null}
                          {firstChange.target.kind === 'new_group' ? (
                            <div className="group__actions">
                              <button
                                type="button"
                                className="btn btn--soft btn--sm"
                                disabled={isReviewing || isApplying}
                                onClick={() => void run(async () => {
                                  if (organizationClient === undefined) return;
                                  setOrganization(await organizationClient.createPreset({
                                    name: firstChange.target.title,
                                    description: firstChange.target.description ?? firstChange.reason,
                                    cues: [],
                                    color: firstChange.target.color,
                                  }));
                                })}
                              >
                                {text.saveAsPreset}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </details>
                    );
                  })}

                  <div className="sticky-cta">
                    <p className="field__note">{text.selectedCount}: {selectedCount}</p>
                    <button
                      type="button"
                      className="btn btn--primary btn--block"
                      disabled={selectedCount === 0 || isApplying || isReviewing}
                      onClick={() => void handleApply()}
                    >
                      {text.applySelected} ({selectedCount})
                    </button>
                  </div>
                </>
              )}
            </section>

            {(organization?.failedTabIds ?? []).length > 0 ? (
              <section className="card">
                <h2 className="card__title">{text.failedAutomatic}</h2>
                {organization?.failedTabIds.map((tabId) => {
                  const summary = tabSummaries.get(tabId);
                  const title = summary?.title ?? `${text.tabLabel} ${tabId}`;
                  // The row repeats one action, so the button carries the tab it acts on in its
                  // accessible name instead of in its visible label.
                  const retryLabel = summary?.hostname === undefined
                    ? `${text.retry} ${title}`
                    : `${text.retry} ${title} · ${summary.hostname}`;
                  return (
                    <article key={tabId} className="row">
                      <span className="swatch swatch--grey" aria-hidden="true" />
                      <span className="row__main">
                        <span className="row__title">{title}</span>
                        {summary?.hostname === undefined ? null : (
                          <span className="row__meta">{summary.hostname}</span>
                        )}
                      </span>
                      <span className="row__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          aria-label={retryLabel}
                          onClick={() => void run(async () => {
                            if (organizationClient !== undefined) setOrganization(await organizationClient.retryFirstPage(tabId));
                          })}
                        >
                          {text.retry}
                        </button>
                      </span>
                    </article>
                  );
                })}
              </section>
            ) : null}
          </>
        ) : null}

        {section === 'presets' && !organizationUnavailable ? (
          <>
            <section className="card">
              <h1 className="card__title">{text.presetsTitle}</h1>
              <form className="card__form" onSubmit={handlePresetSubmit} noValidate>
                <label className="field__label">
                  {text.presetName}
                  <input
                    value={presetDraft.name}
                    aria-invalid={presetErrors.name}
                    aria-describedby={presetErrors.name ? 'preset-name-error' : undefined}
                    onChange={(event) => {
                      setPresetDraft({ ...presetDraft, name: event.currentTarget.value });
                      if (presetErrors.name) setPresetErrors({ ...presetErrors, name: false });
                    }}
                  />
                </label>
                {presetErrors.name ? (
                  <p className="field__error" id="preset-name-error" role="alert">{text.presetNameRequired}</p>
                ) : null}

                <label className="field__label">
                  {text.presetDescription}
                  <input
                    value={presetDraft.description}
                    aria-invalid={presetErrors.description}
                    aria-describedby={presetErrors.description ? 'preset-description-error' : undefined}
                    onChange={(event) => {
                      setPresetDraft({ ...presetDraft, description: event.currentTarget.value });
                      if (presetErrors.description) setPresetErrors({ ...presetErrors, description: false });
                    }}
                  />
                </label>
                {presetErrors.description ? (
                  <p className="field__error" id="preset-description-error" role="alert">
                    {text.presetDescriptionRequired}
                  </p>
                ) : null}

                <label className="field__label">
                  {text.presetCues}
                  <input value={cuesText} onChange={(event) => setCuesText(event.currentTarget.value)} />
                </label>

                <fieldset className="field swatch-picker">
                  <legend className="field__label">
                    {text.presetColor}: {text[colorKeys[presetDraft.color]]}
                  </legend>
                  <div className="swatch-picker__list">
                    {colors.map((color) => (
                      <label key={color} className="swatch-option">
                        <input
                          type="radio"
                          name="preset-color"
                          value={color}
                          checked={presetDraft.color === color}
                          aria-label={text[colorKeys[color]]}
                          onChange={() => setPresetDraft({ ...presetDraft, color })}
                        />
                        <span className={`swatch swatch--${color}`} aria-hidden="true" />
                      </label>
                    ))}
                  </div>
                </fieldset>

                <button type="submit" className="btn btn--primary btn--block" disabled={isPresetSubmitting}>
                  {editingPresetId === null ? text.createPreset : text.updatePreset}
                </button>
              </form>
            </section>

            {(organization?.presets ?? []).length === 0 ? <p className="empty">{text.noPresets}</p> : organization?.presets.map((preset) => (
              <article key={preset.id} className="row">
                <span className={`swatch swatch--${preset.color}`} aria-hidden="true" />
                <span className="row__main">
                  <span className="row__title">{preset.name}</span>
                  <span className="row__meta">{preset.description}</span>
                </span>
                <span className="row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setEditingPresetId(preset.id);
                      setPresetDraft({
                        name: preset.name,
                        description: preset.description,
                        cues: preset.cues,
                        color: preset.color,
                      });
                      setCuesText(preset.cues.join(', '));
                    }}
                  >
                    {text.edit}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={() => void run(async () => {
                      if (organizationClient !== undefined) setOrganization(await organizationClient.deletePreset(preset.id));
                    })}
                  >
                    {text.deletePreset}
                  </button>
                </span>
              </article>
            ))}
          </>
        ) : null}

        {section === 'locked' && !organizationUnavailable ? (
          <>
            <section className="card">
              <h1 className="card__title">{text.lockedTitle}</h1>
              {(organization?.locks ?? []).length === 0 ? <p className="empty">{text.noLockedTabs}</p> : null}
            </section>

            {organization?.locks.map((lock) => (
              <article key={lock.tabId} className="row">
                <span className="swatch swatch--grey" aria-hidden="true" />
                <span className="row__main">
                  <span className="row__title">
                    {tabSummaries.get(lock.tabId)?.title ?? `${text.tabLabel} ${lock.tabId}`}
                  </span>
                  {tabSummaries.get(lock.tabId)?.hostname === undefined ? null : (
                    <span className="row__meta">{tabSummaries.get(lock.tabId)?.hostname}</span>
                  )}
                  <span className="row__meta">
                    {lock.changed ? text.changedSinceLock : text.unchangedSinceLock}
                  </span>
                </span>
                <span className="row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void run(async () => {
                      if (organizationClient !== undefined) setOrganization(await organizationClient.unlockTab(lock.tabId));
                    })}
                  >
                    {text.unlock}
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => void run(async () => {
                      if (organizationClient !== undefined) setOrganization(await organizationClient.unlockAndAnalyze(lock.tabId));
                    })}
                  >
                    {text.unlockAnalyze}
                  </button>
                </span>
              </article>
            ))}
          </>
        ) : null}

        {section === 'history' && !organizationUnavailable ? (
          <>
            <section className="card">
              <h1 className="card__title">{text.historyTitle}</h1>
              {(organization?.history ?? []).length === 0
                ? <p className="empty">{text.noHistory}</p>
                : <p className="field__note">{text.undoLatestOnly}</p>}
            </section>

            {organization?.history.map((operation) => (
              <article key={operation.id} className="row">
                <span className="swatch swatch--grey" aria-hidden="true" />
                <span className="row__main">
                  <span className="row__title">
                    {operation.kind === 'automatic' ? text.operationAutomatic : text.operationSync} · {operation.tabs.length}
                  </span>
                  <span className="row__meta">{new Date(operation.createdAt).toLocaleString(locale)}</span>
                </span>
                <span className="row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={operation.id !== undoableId || undoingOperationId === operation.id}
                    onClick={() => {
                      if (organizationClient === undefined || undoingOperationId !== null) return;
                      setUndoingOperationId(operation.id);
                      void run(async () => {
                        try {
                          setOrganization(await organizationClient.undo(operation.id));
                        } finally {
                          setUndoingOperationId(null);
                        }
                      });
                    }}
                  >
                    {operation.undoneAt === null ? text.undo : text.undone}
                  </button>
                </span>
              </article>
            ))}
          </>
        ) : null}

        {section === 'settings' ? (
          <>
            <section className="card">
              <h1 className="card__title">{withProviderName(text.connectTitle, providerName)}</h1>
              <p className="card__subtitle">
                {withProviderName(text.connectDescription, providerName)}
              </p>

              <label className="field__label" htmlFor="provider">{text.providerLabel}</label>
              <select
                id="provider"
                value={settings.provider}
                onChange={(event) => void handleProviderChange(event.currentTarget.value as Provider)}
              >
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value}>{text[option.labelKey]}</option>
                ))}
              </select>
              {/* Each provider keeps its own key, so switching does not ask for the key again. */}
              <p className="field__note">
                {text.providerKeysLabel}: {PROVIDERS.map((provider) => {
                  const label = text[providerKeyLabels[provider]];
                  const state = settings.providerKeys[provider]
                    ? text.providerKeyPresent
                    : text.providerKeyAbsent;
                  return `${label} ${state}`;
                }).join(' · ')}
              </p>

              <form className="card__form" onSubmit={handleKeySubmit}>
                {settings.apiKeyConfigured ? (
                  <div className="masked-key" aria-label={text.maskedKey}>
                    <span>{text.maskedKey}</span><code>••••••••</code>
                  </div>
                ) : null}
                <label className="field__label" htmlFor="api-key">
                  {withProviderName(text.apiKeyLabel, providerName)}
                </label>
                <input
                  id="api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={text.apiKeyPlaceholder}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
                <div className="btn-row">
                  <button type="submit" className="btn btn--primary" disabled={isSaving || apiKey.trim().length === 0}>
                    {isSaving ? text.testingConnection : text.saveAndTest}
                  </button>
                  {settings.apiKeyConfigured ? (
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={isSaving}
                      onClick={() => void run(async () => {
                        setSettings(await settingsClient.deleteApiKey());
                      })}
                    >
                      {text.deleteKey}
                    </button>
                  ) : null}
                </div>
              </form>
              <p className={`banner banner--${statusTone}`} role="status">{text[statusKey]}</p>
            </section>

            <section className="card">
              <h2 className="card__title">{text.behaviorTitle}</h2>
              <label className="field__label" htmlFor="language">{text.languageLabel}</label>
              <select
                id="language"
                value={settings.localeSelection}
                onChange={(event) => void run(async () => {
                  setSettings(await settingsClient.setLocale(event.currentTarget.value as LocaleSelection));
                })}
              >
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{text[option.labelKey]}</option>
                ))}
              </select>

              <label className="field__label" htmlFor="grouping">{text.groupingLabel}</label>
              <select
                id="grouping"
                value={settings.groupingGranularity}
                onChange={(event) => void run(async () => {
                  setSettings(await settingsClient.setGroupingGranularity(
                    event.currentTarget.value as GroupingGranularity,
                  ));
                })}
              >
                {groupingOptions.map((option) => (
                  <option key={option.value} value={option.value}>{text[option.labelKey]}</option>
                ))}
              </select>

              <label className="field__label" htmlFor="model">{text.modelLabel}</label>
              <div className="inline-field">
                <input id="model" value={model} onChange={(event) => setModel(event.currentTarget.value)} />
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={model.trim().length === 0 || model.trim().length > 100}
                  onClick={() => void run(async () => {
                    setSettings(await settingsClient.setModel(model));
                  })}
                >
                  {text.saveModel}
                </button>
              </div>

              <label className="field__label" htmlFor="base-url">{text.baseUrlLabel}</label>
              <div className="inline-field">
                <input
                  id="base-url"
                  value={baseUrl}
                  spellCheck={false}
                  onChange={(event) => { setBaseUrl(event.currentTarget.value); setBaseUrlError(null); }}
                />
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={isSavingBaseUrl || baseUrl.trim().length === 0}
                  onClick={() => void handleBaseUrlSave()}
                >
                  {text.saveBaseUrl}
                </button>
              </div>
              <p role="note" className={settings.baseUrlIsDefault ? 'field__note' : 'banner banner--warning'}>
                {settings.baseUrlIsDefault
                  ? text.baseUrlDefaultNotice
                  : `${text.baseUrlCustomNotice}: ${settings.baseUrl}`}
              </p>
              {baseUrlError === null ? null : (
                <p role="alert" className="field__error">
                  {baseUrlError === 'invalid' ? text.baseUrlInvalid : text.baseUrlPermissionDenied}
                </p>
              )}

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  aria-describedby="send-path-note"
                  checked={settings.sendPathEnabled}
                  onChange={(event) => void run(async () => {
                    setSettings(await settingsClient.setSendPathEnabled(event.currentTarget.checked));
                  })}
                />
                {text.sendPathLabel}
              </label>
              <p id="send-path-note" className="field__note">{text.sendPathNotice}</p>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.firstPageEnabled}
                  onChange={(event) => void run(async () => {
                    setSettings(await settingsClient.setFirstPageEnabled(event.currentTarget.checked));
                  })}
                />
                {text.firstPageLabel}
              </label>
            </section>

            <section className="card" aria-labelledby="security-title">
              <h2 className="card__title" id="security-title">{text.securityTitle}</h2>
              <p className="field__note">{withProviderName(text.securityBody, providerName)}</p>
              <p className="field__note">{text.storageNotice}</p>
              <p className="field__note">{withProviderName(text.dataNotice, providerName)}</p>
            </section>
          </>
        ) : null}
      </div>

      {shell === 'popup' ? (
        <button
          type="button"
          className="resize-handle"
          aria-label={text.resizeWidth}
          title={`${popupWidth}px`}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onKeyDown={handleResizeKey}
          onDoubleClick={() => {
            resizePopup(POPUP_DEFAULT_WIDTH);
            popupWidthStore?.write(POPUP_DEFAULT_WIDTH);
          }}
        />
      ) : null}
    </main>
  );
}

/**
 * A padlock, drawn rather than written.
 *
 * Emoji are banned in this codebase and a glyph would inherit whatever the platform font decides,
 * so the shape is inline SVG. It carries no accessible name: the button around it does.
 */
function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.75 7V4.9a3.25 3.25 0 0 1 6.5 0V7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="3" y="7" width="10" height="6.75" rx="1.75" fill="currentColor" />
    </svg>
  );
}
