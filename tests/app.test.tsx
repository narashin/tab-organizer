import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '../src/ui/App';
import type { SettingsClient } from '../src/ui/settings-client';
import type { SettingsState } from '../src/background/settings-service';
import { DEFAULT_API_BASE_URL, normalizeBaseUrl } from '../src/shared/base-url';
import type { GroupingGranularity } from '../src/shared/grouping';
import type { LocaleSelection } from '../src/shared/localization';
import { PROVIDER_PROFILES, type Provider } from '../src/shared/provider';

function createState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    localeSelection: 'system',
    locale: 'en',
    provider: 'openai',
    providerKeys: { openai: false, anthropic: false, google: false },
    apiKeyStatus: 'missing',
    apiKeyConfigured: false,
    organizationEnabled: false,
    model: 'gpt-5.6',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlIsDefault: true,
    groupingGranularity: 'balanced',
    sendPathEnabled: false,
    sortTabsEnabled: false,
    firstPageEnabled: true,
    ...overrides,
  };
}

class MemorySettingsClient implements SettingsClient {
  state = createState();

  async getState(): Promise<SettingsState> {
    return this.state;
  }

  async setLocale(localeSelection: LocaleSelection): Promise<SettingsState> {
    this.state = createState({
      ...this.state,
      localeSelection,
      locale: localeSelection === 'system' ? 'en' : localeSelection,
    });
    return this.state;
  }

  async saveAndTestApiKey(apiKey: string): Promise<SettingsState> {
    this.state = createState({
      ...this.state,
      apiKeyStatus: apiKey === 'sk-project-valid' ? 'valid' : 'invalid',
      apiKeyConfigured: true,
      organizationEnabled: apiKey === 'sk-project-valid',
    });
    return this.state;
  }

  async deleteApiKey(): Promise<SettingsState> {
    this.state = createState({ locale: this.state.locale });
    return this.state;
  }

  async setProvider(provider: Provider): Promise<SettingsState> {
    this.state = createState({
      ...this.state,
      provider,
      model: PROVIDER_PROFILES[provider].defaultModel,
      baseUrl: PROVIDER_PROFILES[provider].defaultBaseUrl,
      baseUrlIsDefault: true,
      apiKeyStatus: this.state.providerKeys[provider] ? this.state.apiKeyStatus : 'missing',
      apiKeyConfigured: this.state.providerKeys[provider],
      organizationEnabled: false,
    });
    return this.state;
  }

  async setModel(model: string): Promise<SettingsState> {
    this.state = createState({ ...this.state, model });
    return this.state;
  }

  async setBaseUrl(baseUrl: string): Promise<SettingsState> {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === null) throw new Error('invalid_base_url');
    this.state = createState({
      ...this.state,
      baseUrl: normalized,
      baseUrlIsDefault: normalized === DEFAULT_API_BASE_URL,
    });
    return this.state;
  }

  async setGroupingGranularity(groupingGranularity: GroupingGranularity): Promise<SettingsState> {
    this.state = createState({ ...this.state, groupingGranularity });
    return this.state;
  }

  async setSortTabsEnabled(sortTabsEnabled: boolean): Promise<SettingsState> {
    this.state = createState({ ...this.state, sortTabsEnabled });
    return this.state;
  }
  async setSendPathEnabled(sendPathEnabled: boolean): Promise<SettingsState> {
    this.state = createState({ ...this.state, sendPathEnabled });
    return this.state;
  }

  async setFirstPageEnabled(enabled: boolean): Promise<SettingsState> {
    this.state = createState({ ...this.state, firstPageEnabled: enabled });
    return this.state;
  }
}

const grantAll = { contains: async () => true, request: async () => true };

describe('App', () => {
  it('falls back to English and switches the visible interface language immediately', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={grantAll} />);

    expect(await screen.findByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Language'), 'ko');

    expect(await screen.findByRole('heading', { name: 'OpenAI 연결' })).toBeVisible();
    expect(screen.getByLabelText('언어')).toHaveValue('ko');
    expect(document.documentElement.lang).toBe('ko');
  });

  it('offers the side panel from the popup only, and never from the panel itself', async () => {
    const user = userEvent.setup();
    let opened = 0;
    const client = new MemorySettingsClient();
    const { unmount } = render(
      <App
        shell="popup"
        settingsClient={client}
        permissionBridge={grantAll}
        openSidePanel={async () => { opened += 1; }}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Open side panel' }));
    expect(opened).toBe(1);
    unmount();

    render(
      <App
        shell="panel"
        settingsClient={new MemorySettingsClient()}
        permissionBridge={grantAll}
        openSidePanel={async () => { opened += 1; }}
      />,
    );

    await screen.findByRole('heading', { name: 'Connect OpenAI' });
    expect(screen.queryByRole('button', { name: 'Open side panel' })).not.toBeInTheDocument();
  });

  it('switches provider, moves the model default with it, and names which keys exist', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    client.state = createState({
      providerKeys: { openai: true, anthropic: false, google: false },
      apiKeyConfigured: true,
      apiKeyStatus: 'valid',
      organizationEnabled: true,
    });
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    // A working key lands the interface on Review, so settings needs one click to reach.
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await screen.findByLabelText('AI provider');

    expect(screen.getByLabelText('Classification model')).toHaveValue('gpt-5.6');
    expect(screen.getByText(/Saved keys/)).toHaveTextContent(
      'Saved keys: OpenAI key saved · Anthropic Claude no key · Google Gemini no key',
    );

    await user.selectOptions(screen.getByLabelText('AI provider'), 'anthropic');

    // The draft follows the stored provider rather than carrying OpenAI's model across.
    expect(await screen.findByLabelText('Classification model')).toHaveValue('claude-opus-5');
    expect(screen.getByLabelText('API base URL')).toHaveValue('https://api.anthropic.com/v1');
    // A provider without a key cannot organize, and the status says so.
    expect(screen.getByText('Add a key to enable organization.')).toBeVisible();
  });

  it('asks for host access before storing a key, and stores nothing when it is denied', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    const requested: string[][] = [];
    render(
      <App
        settingsClient={client}
        permissionBridge={{
          contains: async () => false,
          request: async (origins: string[]) => { requested.push(origins); return false; },
        }}
      />,
    );
    await screen.findByLabelText('OpenAI API key');

    await user.type(screen.getByLabelText('OpenAI API key'), 'sk-project-valid');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));

    // Without host access the request could never leave the browser, so the key is not stored.
    expect(requested).toEqual([['https://api.openai.com/*']]);
    expect(client.state.apiKeyConfigured).toBe(false);
    expect(screen.getByText('Chrome denied access to that host, so the endpoint was not changed.')).toBeVisible();
  });

  it('resizes the popup width from the keyboard, persists it, and restores it on the next open', async () => {
    const user = userEvent.setup();
    let stored: number | null = 420;
    const popupWidthStore = {
      read: () => stored,
      write: (width: number) => { stored = width; },
    };
    const { unmount } = render(
      <App shell="popup" settingsClient={new MemorySettingsClient()} permissionBridge={grantAll} popupWidthStore={popupWidthStore} />,
    );
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    const shell = screen.getByRole('main');
    expect(shell).toHaveStyle({ width: '420px' });
    // Height belongs to the content: Chrome will not grow a popup vertically, so the interface must
    // not claim a height it cannot deliver.
    expect(shell.style.height).toBe('');

    const handle = screen.getByRole('button', { name: 'Resize the popup width' });
    handle.focus();
    await user.keyboard('{ArrowRight}');

    expect(shell).toHaveStyle({ width: '440px' });
    expect(stored).toBe(440);

    // The vertical keys no longer belong to this control.
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(shell).toHaveStyle({ width: '440px' });

    // Chrome refuses to render past 800px wide, so the handle must stop there.
    await user.keyboard('{Shift>}{ArrowRight>20/}{/Shift}');
    expect(shell).toHaveStyle({ width: '800px' });

    // Double-clicking returns to the default, the way out of a width dragged to the edge.
    await user.dblClick(handle);
    expect(shell).toHaveStyle({ width: '400px' });
    expect(stored).toBe(400);

    await user.keyboard('{Shift>}{ArrowRight>20/}{/Shift}');
    unmount();
    render(
      <App shell="popup" settingsClient={new MemorySettingsClient()} permissionBridge={grantAll} popupWidthStore={popupWidthStore} />,
    );
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    expect(screen.getByRole('main')).toHaveStyle({ width: '800px' });
  });

  it('never puts a resize handle or an inline size on the side panel', async () => {
    render(<App shell="panel" settingsClient={new MemorySettingsClient()} permissionBridge={grantAll} />);
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    expect(screen.queryByRole('button', { name: 'Resize the popup width' })).not.toBeInTheDocument();
    expect(screen.getByRole('main').getAttribute('style')).toBeNull();
  });

  it('clears the entered key and enables organization after validation succeeds', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    const keyInput = screen.getByLabelText('OpenAI API key');
    await user.type(keyInput, 'sk-project-valid');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));

    expect(await screen.findByText('Connected. Organization is enabled.')).toBeVisible();
    expect(keyInput).toHaveValue('');
    expect(document.body.textContent).not.toContain('sk-project-valid');
  });

  it('shows a recoverable error when initial settings loading fails', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    let attempts = 0;
    client.getState = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('storage_unavailable');
      return client.state;
    };
    render(<App settingsClient={client} permissionBridge={grantAll} />);

    // The banner now carries the code the background reported alongside the sentence.
    expect(await screen.findByText(/The operation failed\. No fallback was used\./)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Connect OpenAI' })).toBeVisible();
    expect(attempts).toBe(2);
  });

  it('reports a settings mutation failure and blocks an empty model', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    client.setFirstPageEnabled = async () => {
      throw new Error('storage_unavailable');
    };
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    await user.clear(screen.getByLabelText('Classification model'));
    expect(screen.getByRole('button', { name: 'Save model' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', {
      name: 'Organize the first page of new tabs automatically',
    }));

    // The banner now carries the code the background reported alongside the sentence.
    expect(await screen.findByText(/The operation failed\. No fallback was used\./)).toBeVisible();
  });

  it('offers alphabetical sorting as an opt-in, with what it costs written next to it', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    await screen.findByRole('heading', { name: 'Connect OpenAI' });

    const checkbox = screen.getByRole('checkbox', {
      name: 'Sort tabs alphabetically after applying',
    });
    expect(checkbox).not.toBeChecked();
    // The order it replaces is gone for good, so the interface has to say so before it is on.
    expect(screen.getByText(/cannot be restored/)).toBeVisible();

    await user.click(checkbox);

    expect(client.state.sortTabsEnabled).toBe(true);
  });

  it('uses a high-contrast keyboard focus outline', async () => {
    const styles = await readFile(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');
    const focusRule = styles.match(
      /button:focus-visible,\s*input:focus-visible,\s*select:focus-visible\s*\{[^}]*outline: 3px solid (#[0-9a-f]{6});/i,
    );
    expect(focusRule).not.toBeNull();
    const focusColor = focusRule?.[1] ?? '#ffffff';
    expect(contrast(focusColor, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(focusColor, '#f4f1e9')).toBeGreaterThanOrEqual(3);
  });

  it('styles every disabled button as unavailable', async () => {
    const styles = await readFile(resolve(process.cwd(), 'src/ui/styles.css'), 'utf8');

    expect(styles).toMatch(/(?:^|\n)button:disabled\s*\{[^}]*cursor: not-allowed;[^}]*opacity: 0\.48;/s);
  });

  it('persists the grouping breadth the user picks', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    await screen.findByLabelText('Grouping breadth');

    expect(screen.getByLabelText('Grouping breadth')).toHaveValue('balanced');
    await user.selectOptions(screen.getByLabelText('Grouping breadth'), 'broad');

    expect(client.state.groupingGranularity).toBe('broad');
    expect(await screen.findByLabelText('Grouping breadth')).toHaveValue('broad');
  });

  it('names the host a custom base URL sends the key to', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={grantAll} />);
    await screen.findByLabelText('API base URL');

    expect(screen.getByRole('note')).toHaveTextContent(
      'Requests and your key go to the default OpenAI endpoint.',
    );

    await user.clear(screen.getByLabelText('API base URL'));
    await user.type(screen.getByLabelText('API base URL'), 'https://gateway.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'Save base URL' }));

    expect(await screen.findByRole('note')).toHaveTextContent(
      'https://gateway.example.test/v1',
    );
    expect(client.state.baseUrl).toBe('https://gateway.example.test/v1');
  });

  it('asks Chrome for the host before saving a custom endpoint', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    const requested: string[][] = [];
    render(<App settingsClient={client} permissionBridge={{
      contains: async (origins) => origins[0] === 'https://api.openai.com/*',
      request: async (origins) => { requested.push(origins); return true; },
    }} />);
    await screen.findByLabelText('API base URL');

    await user.clear(screen.getByLabelText('API base URL'));
    await user.type(screen.getByLabelText('API base URL'), 'https://gw.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'Save base URL' }));

    expect(requested).toEqual([['https://gw.example.test/*']]);
    expect(client.state.baseUrl).toBe('https://gw.example.test/v1');
  });

  it('leaves the endpoint untouched when the host permission is denied', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    render(<App settingsClient={client} permissionBridge={{
      contains: async () => false,
      request: async () => false,
    }} />);
    await screen.findByLabelText('API base URL');

    await user.clear(screen.getByLabelText('API base URL'));
    await user.type(screen.getByLabelText('API base URL'), 'https://gw.example.test/v1');
    await user.click(screen.getByRole('button', { name: 'Save base URL' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Chrome denied access to that host, so the endpoint was not changed.',
    );
    expect(client.state.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('does not prompt when saving the endpoint the manifest already covers', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    const requested: string[][] = [];
    render(<App settingsClient={client} permissionBridge={{
      contains: async (origins) => origins[0] === 'https://api.openai.com/*',
      request: async (origins) => { requested.push(origins); return true; },
    }} />);
    await screen.findByLabelText('API base URL');

    await user.click(screen.getByRole('button', { name: 'Save base URL' }));

    expect(requested).toEqual([]);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Requests and your key go to the default OpenAI endpoint.',
    );
  });

  it('explains a rejected base URL and never prompts for its host', async () => {
    const user = userEvent.setup();
    const client = new MemorySettingsClient();
    const requested: string[][] = [];
    render(<App settingsClient={client} permissionBridge={{
      contains: async () => false,
      request: async (origins) => { requested.push(origins); return true; },
    }} />);
    await screen.findByLabelText('API base URL');

    await user.clear(screen.getByLabelText('API base URL'));
    await user.type(screen.getByLabelText('API base URL'), 'http://example.com/v1');
    await user.click(screen.getByRole('button', { name: 'Save base URL' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an https address, or an http address on localhost.',
    );
    // Prompting first would leave the extension holding access to a host it then refuses to store.
    expect(requested).toEqual([]);
    expect(client.state.baseUrl).toBe('https://api.openai.com/v1');
  });
});

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  return channels
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}
