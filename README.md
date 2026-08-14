# Tab Organizer

Tab Organizer is a Manifest V3 Chrome extension that organizes tabs with a user-provided API key. It supports OpenAI, Anthropic Claude, and Google Gemini, along with any OpenAI-compatible gateway. It supports English, Korean, and Japanese and does not provide a non-AI grouping fallback.

## Features

- Organizes the first eligible page of a newly created tab once. Later navigation is not automatically regrouped.
- Limits automatic classification across the extension profile to 30 classifier requests in a rolling 60-second window.
- Reviews all eligible tabs in the current window or every normal window before applying changes.
- Supports persistent group presets for private project names and domain-specific context.
- Provides one-run exclusions, session-scoped tab locks, Split View protection, and the ten most recent undo operations.
- Sends only ephemeral tab references, titles, hostnames, group descriptors, and preset context. The URL path is sent only if the user opts in, and the query string and fragment never are.

## Requirements

- Chrome 116 or newer; Split View protection is activated when Chrome 140+ exposes `splitViewId`.
- Node.js 20.19 or newer, 22.12 or newer, or 24 or newer.
- npm 11 or a compatible npm release.
- A `zip` command compatible with Info-ZIP for `npm run package`.
- A dedicated API key with a spending limit, from OpenAI, Anthropic, or Google. A key is stored per provider, so switching providers does not ask for the key again.

The local verification environment uses Node.js 25.4.0 and npm 11.7.0.

## Local setup

```bash
npm install
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select this repository's absolute `dist/` directory. Clicking the toolbar action opens the popup; drag its bottom-right corner to resize it, or use Open side panel for a persistent panel that renders the same interface.

In Settings, pick an AI provider, select a language, enter a dedicated key for that provider, confirm the default model for it (`gpt-5.6`, `claude-opus-5`, or `gemini-3.5-flash`) or enter another model ID, and choose whether first-page organization is enabled. Chrome asks for host access when a key is saved for a provider other than OpenAI, and the key is not stored if access is denied.

To use a gateway instead of a provider's own endpoint, set API base URL to that endpoint, for example `https://gateway.example.com/v1`. The endpoint, the model, and the validation result are stored per provider. Chrome asks for host access the first time a non-default host is saved, and the endpoint is not changed if access is denied. The address must use https, except on `localhost` and `127.0.0.1` where http is accepted so a local runtime remains usable. Saving a different endpoint clears the previous validation result, so the key must be tested again before organization is re-enabled. Model IDs differ between providers, so the default `gpt-5.6` may need to change as well.

## Workflow

1. Define Presets for internal projects and product names when useful.
2. Use Sync all windows or Sync current window.
3. Review group summaries, reject a proposed group, lock a specific tab, or deselect tabs that should remain unchanged for this run.
4. Apply selected changes. Split View tabs remain blocked until Split View is exited in Chrome.
5. Use History to undo an extension operation for tabs that still exist and remain in the group applied by that operation. Later manual group changes are preserved. If an exact Chrome group ID is unavailable, undo falls back to the stored group title and color.

Locking a tab excludes it before a classification request is built. A lock remains attached to that tab after navigation and ends when it is unlocked, closed, or the Chrome session ends.

Immediately before each reviewed group move, the extension rechecks the selected tabs, locks, window, URL, title, current group, and Split View state. Automatic batches for the same window run serially, and a failed new-group metadata update attempts to restore each tab's prior Chrome group membership.

The automatic request budget is shared by all windows and survives service-worker restarts for the current Chrome session. A batch that arrives after 30 classifier requests in the preceding 60 seconds is marked failed without calling the provider, moving tabs, or scheduling an automatic retry.

## BYOK and privacy

A browser extension cannot provide server-grade secrecy for a standard API key. The extension stores the key only in `chrome.storage.local`, restricts access to trusted extension contexts, never stores it in Chrome Sync, and never returns it in interface state or logs.

Connection validation uses `GET <base URL>/models`. Classification uses the Responses API at `POST <base URL>/responses` with strict structured output and `store: false`. The base URL defaults to `https://api.openai.com/v1` and is user-configurable, so the destination host is whatever the user has saved. Full URLs, page content, screenshots, cookies, forms, and browsing history are not sent. Incognito and locked tabs are excluded before payload construction.

See [Privacy](docs/privacy.md) for the complete data boundary and revocation guidance.

## Verification and packaging

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
npm run package
```

`npm run test:e2e` launches a fresh Chromium profile with mocked provider endpoints. It verifies valid, invalid, and offline BYOK states; three locales; keyboard navigation; preset persistence; service-worker proposal rehydration; actual Chrome group mutation and undo; and a 101-tab acceptance run across multiple windows. It never uses a real API key.

`npm run package` creates `tab-organizer.zip` with `manifest.json` at the archive root. The package contains no API key or test credential.

## Permissions

- `sidePanel`: persistent review interface.
- `storage`: local settings, presets, history, and session state.
- `tabs`: tab metadata, lifecycle, grouping, and undo.
- `tabGroups`: group titles, colors, and window-scoped metadata.
- `https://api.openai.com/*`: connection validation and classification only.
- `optional_host_permissions` (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`): declared broadly because a user-supplied gateway address cannot be known in advance. Nothing is granted at install time. Access is requested for one specific origin, only when the user saves a custom API base URL, and only after that address passes validation.

## Environments

| Environment | Credentials | Verification |
| --- | --- | --- |
| Local | Mocked provider responses by default; developer BYOK only for an explicit check | Typecheck, unit/integration tests, build, unpacked Chromium E2E |
| Dev | Tester-owned limited-budget project key | Live connection smoke test and multilingual review |
| Test | Deterministic mocks; dedicated test key only when explicitly enabled | Failure matrix, 100+ tabs, multi-window and Split View scenarios |
| Prod | Every user supplies a key; no bundled credential | Package, permission, privacy, secret and accessibility audit |

Publishing to the Chrome Web Store is intentionally outside this repository workflow.
