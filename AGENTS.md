# Repository Instructions

## Project scope

This repository contains the T-1 through T-8 implementation of a Manifest V3 Chrome extension for AI-assisted tab organization. The active PLAN governs onboarding, presets, locks, first-page organization, reviewed synchronization, Split View safety, and production packaging.

## Commands

- Install: `npm install`
- Typecheck: `npm run typecheck`
- Repository lint: `npm run lint`
- Unit and integration tests: `npm test`
- Production build: `npm run build`
- Chromium extension E2E: `npm run test:e2e`
- Production package: `npm run package`
- Load locally: build, then load the absolute `dist/` directory with Chrome's Load unpacked action.

## Architecture boundaries

- `src/ui/` renders UI and communicates through typed runtime messages. It must not call a model provider or Chrome tab mutation APIs directly.
- `src/ui/App.tsx` is shared by both surfaces. `src/ui/popup.tsx` and `src/ui/sidepanel.tsx` are the entries; only the frame width and the side panel shortcut differ.
- The action opens `popup.html`. `sidepanel.html` renders the same app and is reachable from the popup, so `setPanelBehavior` stays off. `chrome.sidePanel.open` runs from the click in the popup entry, because forwarding it would lose the user gesture.
- `src/background/` owns extension-local storage, API key validation, message handling, and Side Panel setup.
- `src/background/classifier/` holds one adapter per provider. `contract.ts` owns everything provider-agnostic: types, timeout policy, prompts, the JSON schemas, and decision validation. An adapter contributes request assembly and response extraction only, and the classifier and the taxonomy planner of a run always come from the same provider.
- `src/shared/` contains typed localization and safe logging utilities.
- `public/manifest.json` and `public/_locales/` are copied into `dist/` by Vite.
- API keys use `chrome.storage.local` only, one slot per provider under `apiKeys`. Never use `chrome.storage.sync` for secrets.
- User-visible copy that names the provider carries a `{provider}` placeholder filled by `withProviderName`. Never hardcode a provider name in a string a user reads.
- Key validation uses `GET {baseUrl}/models` for every provider. Verdicts: 200 valid, 401/403 invalid, anything else an error. Google is the exception measured on 2026-08-14: it rejects a key with `400 INVALID_ARGUMENT` and `error.details[].reason === "API_KEY_INVALID"`, which counts as invalid.
- Classification forces JSON through each provider's own mechanism: OpenAI `text.format.json_schema` (strict), Anthropic `output_config.format`, Gemini `generationConfig.responseSchema`. Anthropic also requires `max_tokens`; too low truncates the JSON and surfaces as schema validation failure rather than a limit.
- API keys travel in headers only, never in a query string. Gemini documents a `?key=` form; the extension does not use it.
- Gemini names the model in the request path, so a model ID must be percent-encoded before it is placed there.
- `chrome.storage.session` stores tab locks, first-page state, and the latest review proposal; `chrome.storage.local` stores settings, presets, history, and the BYOK key.

## Implementation rules

- Use TypeScript strict mode and never use the `any` type.
- Keep code comments, identifiers, logs, AI prompts, and error codes in English.
- Keep user-visible strings in the typed English, Korean, and Japanese catalogs. Unsupported locales fall back to English.
- Keep manifest locale keys at parity across English, Korean, and Japanese.
- Do not use emoji in product UI, code, logs, or documentation examples.
- Keep permissions minimal. The product declares only `sidePanel`, `storage`, `tabs`, `tabGroups`, and the OpenAI API host origin. Anthropic, Google, and custom endpoints are granted at runtime through `ensureHostAccess` from a user gesture, so installing the extension never asks for them.
- Treat `chrome.tabs.SPLIT_VIEW_ID_NONE` (`-1`) as not being in Split View.
- The guard only holds for tabs Chrome reports as split. Measured on Chrome 140 (2026-08-18): a split pair with no group is reported and blocked, while a split pair inside a tab group comes back without a split id, so the review treats those tabs as ordinary and can separate them. Do not restate the blanket promise that a Split View tab is never moved.
- Never include API keys in UI state, logs, error details, or Chrome Sync.
- Update `docs/plan/` before code when requirements change and record exact verification results. These notes are untracked on purpose and stay on the machine that wrote them.

## Environments

- Local: unpacked `dist/`, mocked provider responses by default, developer BYOK only for explicit manual checks.
- Dev: shareable development build with a tester-owned limited-budget project key.
- Test: deterministic mock responses; dedicated test key only for opt-in external checks.
- Prod: Chrome Web Store package with no bundled key; every user supplies a key.


<claude-mem-context>
# Memory Context

# [chrome-tab-wrapper] recent context, 2026-08-12 1:24pm GMT+9

No previous sessions found.
</claude-mem-context>
