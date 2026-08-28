/**
 * Popup application tests
 *
 * Drives the REAL src/popup/app.ts module: initPopup() queries a fixture DOM,
 * populates it from mocked storage, and wires the save/test flows. The
 * index.ts entry shim stays a DOMContentLoaded one-liner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionSettings, ChatBackfillRequest } from '../../src/lib/types';

vi.mock('../../src/lib/storage', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('../../src/lib/messaging', () => ({
  sendMessage: vi.fn(),
}));

import { getSettings, saveSettings } from '../../src/lib/storage';
import { sendMessage } from '../../src/lib/messaging';
import { initPopup } from '../../src/popup/app';

const VALID_API_KEY = 'a'.repeat(32);

const storedSettings: ExtensionSettings = {
  obsidianApiKey: VALID_API_KEY,
  obsidianUrl: 'http://127.0.0.1:27123',
  vaultPath: 'AI/Gemini',
  imageVaultPath: 'AI/Gemini/images',
  maxCalloutLines: 200,
  enableAutoScroll: true,
  enableAppendMode: false,
  enableToolContent: false,
  enableImageExport: true,
  flattenLargeCallouts: true,
  companionToken: '',
  companionUrl: 'http://127.0.0.1:3447',
  autoSyncPlatforms: ['claude', 'chatgpt'],
  outputOptions: { obsidian: true, file: false, clipboard: true },
  templateOptions: {
    messageFormat: 'callout',
    userCalloutType: 'QUESTION',
    assistantCalloutType: 'NOTE',
    includeQuestionHeaders: false,
    includeId: true,
    includeTitle: true,
    includeTags: false,
    includeSource: true,
    includeDates: true,
    includeMessageCount: true,
    timezone: 'UTC',
  },
};

const SWITCH_IDS = [
  'outputObsidian',
  'outputFile',
  'outputClipboard',
  'includeQuestionHeaders',
  'includeId',
  'includeTitle',
  'includeTags',
  'includeSource',
  'includeDates',
  'includeMessageCount',
  'enableAutoScroll',
  'enableAppendMode',
  'enableToolContent',
  'enableImageExport',
  'flattenLargeCallouts',
  'autoSyncGemini',
  'autoSyncClaude',
  'autoSyncChatgpt',
  'autoSyncPerplexity',
  'autoSyncNotebooklm',
];

function buildPopupDom(): void {
  const switches = SWITCH_IDS.map(
    id => `<input type="checkbox" id="${id}" role="switch" aria-checked="false" />`
  ).join('\n');

  document.body.innerHTML = `
    <section id="obsidianSettings">
      <div class="api-key-wrapper">
        <input type="password" id="apiKey" />
      </div>
      <input type="text" id="obsidianUrl" />
      <input type="text" id="vaultPath" />
      <input type="text" id="imageVaultPath" />
      <input type="number" id="maxCalloutLines" />
      <input type="password" id="companion-token" />
      <input type="text" id="companion-url" />
    </section>
    ${switches}
    <select id="messageFormat">
      <option value="callout">callout</option>
      <option value="plain">plain</option>
      <option value="blockquote">blockquote</option>
    </select>
    <select id="filenameScheme">
      <option value="title-id">title-id</option>
      <option value="title-date">title-date</option>
    </select>
    <div id="calloutSettingsGroup">
      <input type="text" id="userCallout" />
      <input type="text" id="assistantCallout" />
    </div>
    <div id="timezoneGroup">
      <select id="timezone"><option value="UTC">UTC</option></select>
    </div>
    <button id="testBtn"></button>
    <button id="saveBtn"></button>
    <div id="status" class="status"></div>
    <button id="importBtn"></button>
    <div id="importResults"></div>
  `;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function statusEl(): HTMLDivElement {
  return el<HTMLDivElement>('status');
}

async function initWithDefaults(): Promise<void> {
  buildPopupDom();
  vi.mocked(getSettings).mockResolvedValue(storedSettings);
  await initPopup();
}

describe('popup/app', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initPopup', () => {
    it('populates the form from stored settings', async () => {
      await initWithDefaults();

      expect(el<HTMLInputElement>('apiKey').value).toBe(VALID_API_KEY);
      expect(el<HTMLInputElement>('obsidianUrl').value).toBe('http://127.0.0.1:27123');
      expect(el<HTMLInputElement>('vaultPath').value).toBe('AI/Gemini');
      expect(el<HTMLInputElement>('outputObsidian').checked).toBe(true);
      expect(el<HTMLInputElement>('outputClipboard').checked).toBe(true);
      expect(el<HTMLInputElement>('outputFile').checked).toBe(false);
      expect(el<HTMLInputElement>('enableAutoScroll').checked).toBe(true);
      expect(el<HTMLInputElement>('includeTags').checked).toBe(false);
      expect(el<HTMLSelectElement>('messageFormat').value).toBe('callout');
    });

    it('populates the timezone dropdown with IANA zones', async () => {
      await initWithDefaults();

      const timezone = el<HTMLSelectElement>('timezone');
      expect(timezone.options.length).toBeGreaterThan(1);
      expect(timezone.value).toBe('UTC');
    });

    it('syncs aria-checked with the populated checkbox state', async () => {
      await initWithDefaults();

      expect(el<HTMLInputElement>('outputObsidian').getAttribute('aria-checked')).toBe('true');
      expect(el<HTMLInputElement>('outputFile').getAttribute('aria-checked')).toBe('false');
    });

    it('keeps aria-checked in sync when a switch changes', async () => {
      await initWithDefaults();

      const toggle = el<HTMLInputElement>('outputFile');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });

    it('applies defaults when stored settings have missing optional fields', async () => {
      buildPopupDom();
      const partial = {
        ...storedSettings,
        obsidianApiKey: '',
        obsidianUrl: '',
        outputOptions: undefined,
        enableAutoScroll: undefined,
        enableAppendMode: undefined,
        enableToolContent: undefined,
        templateOptions: { messageFormat: '', userCalloutType: '', assistantCalloutType: '' },
      } as unknown as ExtensionSettings;
      vi.mocked(getSettings).mockResolvedValue(partial);

      await initPopup();

      expect(el<HTMLInputElement>('outputObsidian').checked).toBe(true); // default on
      expect(el<HTMLInputElement>('outputFile').checked).toBe(false);
      expect(el<HTMLInputElement>('enableAutoScroll').checked).toBe(false);
      expect(el<HTMLInputElement>('obsidianUrl').value).toBe('http://127.0.0.1:27123');
      expect(el<HTMLSelectElement>('messageFormat').value).toBe('callout');
      expect(el<HTMLInputElement>('userCallout').value).toBe('QUESTION');
      expect(el<HTMLInputElement>('assistantCallout').value).toBe('NOTE');
      expect(el<HTMLInputElement>('includeId').checked).toBe(true); // ?? true default
      expect(el<HTMLSelectElement>('timezone').value).toBe('UTC');
    });

    it('translates data-i18n elements when a translation exists', async () => {
      buildPopupDom();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<span id="i18nLabel" data-i18n="settings_title"></span>' +
          '<input id="i18nInput" data-i18n-placeholder="settings_apiKeyPlaceholder" />'
      );
      // Ensure the data-i18n title is the FIRST <title> the app queries
      document.querySelectorAll('title').forEach(t => t.remove());
      document.head.insertAdjacentHTML('beforeend', '<title data-i18n="extName"></title>');
      vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => `T_${key}`);
      vi.mocked(getSettings).mockResolvedValue(storedSettings);

      try {
        await initPopup();

        expect(document.getElementById('i18nLabel')!.textContent).toBe('T_settings_title');
        expect((document.getElementById('i18nInput') as HTMLInputElement).placeholder).toBe(
          'T_settings_apiKeyPlaceholder'
        );
        expect(document.title).toBe('T_extName');
      } finally {
        vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => key);
        document.head.querySelector('title[data-i18n]')?.remove();
      }
    });

    it('rejects when a required element is missing from the DOM', async () => {
      buildPopupDom();
      document.getElementById('saveBtn')!.remove();
      vi.mocked(getSettings).mockResolvedValue(storedSettings);

      await expect(initPopup()).rejects.toThrow('Missing element: #saveBtn');
    });

    it('does not repopulate the timezone dropdown on re-init', async () => {
      await initWithDefaults();
      const countAfterFirst = el<HTMLSelectElement>('timezone').options.length;

      await initPopup(); // same DOM, second run hits the early-return guard

      expect(el<HTMLSelectElement>('timezone').options.length).toBe(countAfterFirst);
    });

    it('shows an error status when settings cannot be loaded', async () => {
      buildPopupDom();
      vi.mocked(getSettings).mockRejectedValue(new Error('storage down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await initPopup();

      expect(statusEl().textContent).toBe('toast_error_connectionFailed');
      expect(statusEl().className).toBe('status error');
      errorSpy.mockRestore();
    });
  });

  describe('section visibility', () => {
    it('disables the Obsidian section when Obsidian output is off', async () => {
      buildPopupDom();
      vi.mocked(getSettings).mockResolvedValue({
        ...storedSettings,
        outputOptions: { obsidian: false, file: true, clipboard: false },
      });
      await initPopup();

      expect(el('obsidianSettings').classList.contains('disabled')).toBe(true);
    });

    it('re-enables the Obsidian section when the toggle is switched on', async () => {
      buildPopupDom();
      vi.mocked(getSettings).mockResolvedValue({
        ...storedSettings,
        outputOptions: { obsidian: false, file: true, clipboard: false },
      });
      await initPopup();

      const toggle = el<HTMLInputElement>('outputObsidian');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      expect(el('obsidianSettings').classList.contains('disabled')).toBe(false);
    });

    it('hides callout settings for non-callout formats', async () => {
      await initWithDefaults();

      const format = el<HTMLSelectElement>('messageFormat');
      format.value = 'plain';
      format.dispatchEvent(new Event('change'));

      expect(el('calloutSettingsGroup').style.display).toBe('none');
    });

    it('hides the timezone group when dates are excluded', async () => {
      await initWithDefaults();

      const includeDates = el<HTMLInputElement>('includeDates');
      includeDates.checked = false;
      includeDates.dispatchEvent(new Event('change'));

      expect(el('timezoneGroup').style.display).toBe('none');
    });
  });

  describe('API key visibility toggle', () => {
    it('appends a toggle button that reveals and hides the key', async () => {
      await initWithDefaults();

      const toggleBtn = document.querySelector<HTMLButtonElement>('.api-key-toggle');
      expect(toggleBtn).not.toBeNull();

      const apiKey = el<HTMLInputElement>('apiKey');
      expect(apiKey.type).toBe('password');

      toggleBtn!.click();
      expect(apiKey.type).toBe('text');

      toggleBtn!.click();
      expect(apiKey.type).toBe('password');
    });
  });

  describe('save flow', () => {
    it('saves collected settings and shows a success status', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);

      el<HTMLInputElement>('vaultPath').value = '  AI/Claude  ';
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianApiKey: VALID_API_KEY,
          vaultPath: 'AI/Claude',
          outputOptions: { obsidian: true, file: false, clipboard: true },
        })
      );
      expect(statusEl().textContent).toBe('status_settingsSaved');
      expect(statusEl().className).toBe('status success');
      expect(el<HTMLButtonElement>('saveBtn').disabled).toBe(false);
    });

    it('collects the selected filename scheme into templateOptions (#328)', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);

      el<HTMLSelectElement>('filenameScheme').value = 'title-date';
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          templateOptions: expect.objectContaining({ filenameScheme: 'title-date' }),
        })
      );
    });

    it('populates the per-platform auto-sync toggles from the loaded settings', async () => {
      await initWithDefaults(); // storedSettings.autoSyncPlatforms = ['claude', 'chatgpt']

      expect(el<HTMLInputElement>('autoSyncGemini').checked).toBe(false);
      expect(el<HTMLInputElement>('autoSyncClaude').checked).toBe(true);
      expect(el<HTMLInputElement>('autoSyncChatgpt').checked).toBe(true);
      expect(el<HTMLInputElement>('autoSyncPerplexity').checked).toBe(false);
      expect(el<HTMLInputElement>('autoSyncNotebooklm').checked).toBe(false);
    });

    it('collects the per-platform auto-sync toggle state on save', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);

      // Flip Gemini on and Claude off from the loaded ['claude', 'chatgpt'].
      el<HTMLInputElement>('autoSyncGemini').checked = true;
      el<HTMLInputElement>('autoSyncClaude').checked = false;
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ autoSyncPlatforms: ['gemini', 'chatgpt'] })
      );
    });

    it('rejects saving when no output destination is selected', async () => {
      await initWithDefaults();

      for (const id of ['outputObsidian', 'outputFile', 'outputClipboard']) {
        el<HTMLInputElement>(id).checked = false;
      }
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(statusEl().textContent).toBe('error_noOutputSelected'));
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('rejects an API key shorter than the security minimum', async () => {
      await initWithDefaults();

      el<HTMLInputElement>('apiKey').value = 'short';
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(statusEl().className).toBe('status error'));
      expect(statusEl().textContent).toContain('too short');
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('rejects an invalid companion URL scheme', async () => {
      await initWithDefaults();

      el<HTMLInputElement>('companion-url').value = 'ftp://127.0.0.1:3447';
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(statusEl().className).toBe('status error'));
      expect(statusEl().textContent).toContain('http or https');
      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('accepts a plain-http companion URL (the companion cannot do TLS on loopback)', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);

      el<HTMLInputElement>('companion-url').value = 'http://127.0.0.1:3447/';
      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ companionUrl: 'http://127.0.0.1:3447' })
      );
    });

    it('skips Obsidian validation when Obsidian output is disabled', async () => {
      buildPopupDom();
      vi.mocked(getSettings).mockResolvedValue({
        ...storedSettings,
        obsidianApiKey: '',
        outputOptions: { obsidian: false, file: true, clipboard: false },
      });
      vi.mocked(saveSettings).mockResolvedValue(undefined);
      await initPopup();

      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
      expect(statusEl().textContent).toBe('status_settingsSaved');
    });

    it('shows an error status when persisting settings fails', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockRejectedValue(new Error('quota exceeded'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      el<HTMLButtonElement>('saveBtn').click();

      await vi.waitFor(() => expect(statusEl().className).toBe('status error'));
      expect(statusEl().textContent).toBe('toast_error_saveFailed');
      expect(el<HTMLButtonElement>('saveBtn').disabled).toBe(false);
      errorSpy.mockRestore();
    });
  });

  describe('test connection flow', () => {
    it('saves settings then reports a successful connection', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);
      vi.mocked(sendMessage).mockResolvedValue({ success: true });

      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().textContent).toBe('status_connectionSuccess'));
      expect(saveSettings).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith({ action: 'testConnection' });
      expect(el<HTMLButtonElement>('testBtn').disabled).toBe(false);
    });

    it('reports the backend error when the connection test fails', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);
      vi.mocked(sendMessage).mockResolvedValue({ success: false, error: 'Invalid API key' });

      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().textContent).toBe('Invalid API key'));
      expect(statusEl().className).toBe('status error');
    });

    it('warns and skips the test when no API key is entered', async () => {
      await initWithDefaults();

      el<HTMLInputElement>('apiKey').value = '';
      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().textContent).toBe('toast_error_noApiKey'));
      expect(statusEl().className).toBe('status warning');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('rejects invalid Obsidian settings before testing', async () => {
      await initWithDefaults();

      el<HTMLInputElement>('obsidianUrl').value = 'ftp://example.com';
      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().className).toBe('status error'));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('rejects an invalid companion URL before testing', async () => {
      await initWithDefaults();

      el<HTMLInputElement>('companion-url').value = 'ftp://127.0.0.1:3447';
      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().className).toBe('status error'));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('shows the thrown message when the test itself errors', async () => {
      await initWithDefaults();
      vi.mocked(saveSettings).mockResolvedValue(undefined);
      vi.mocked(sendMessage).mockRejectedValue(new Error('port closed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      el<HTMLButtonElement>('testBtn').click();

      await vi.waitFor(() => expect(statusEl().textContent).toBe('port closed'));
      expect(statusEl().className).toBe('status error');
      errorSpy.mockRestore();
    });
  });

  describe('import history', () => {
    function stubActiveTab(url: string): void {
      vi.mocked(chrome.tabs.query).mockResolvedValue([{ id: 7, url } as chrome.tabs.Tab]);
    }

    function stubDiscovery(conversations: Partial<ChatBackfillRequest>[]): void {
      vi.mocked(chrome.tabs.sendMessage).mockResolvedValue({ success: true, conversations });
    }

    function importResultsText(): string {
      return el<HTMLDivElement>('importResults').textContent ?? '';
    }

    it('disables Import history when the active tab is not a supported platform', async () => {
      stubActiveTab('https://example.com/');
      await initWithDefaults();

      expect(el<HTMLButtonElement>('importBtn').disabled).toBe(true);
    });

    it('enables Import history when the active tab is a supported platform', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      await initWithDefaults();

      expect(el<HTMLButtonElement>('importBtn').disabled).toBe(false);
    });

    it('dispatches one chatBackfill message per discovered conversation', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
      await initWithDefaults();
      vi.mocked(sendMessage).mockResolvedValue({
        notePath: '/vault/note.md',
        anchorsPreserved: 0,
        anchorsIssued: 0,
        superseded: 0,
        skipped: null,
      });

      el<HTMLButtonElement>('importBtn').click();

      await vi.waitFor(() => {
        const calls = vi
          .mocked(sendMessage)
          .mock.calls.filter(([message]) => message.action === 'chatBackfill');
        expect(calls).toHaveLength(2);
      });
    });

    it('reports a skipped conversation with its reason', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([{ conversationId: 'c1' }]);
      await initWithDefaults();
      vi.mocked(sendMessage).mockResolvedValue({
        notePath: null,
        anchorsPreserved: 0,
        anchorsIssued: 0,
        superseded: 0,
        skipped: 'truncated',
      });

      el<HTMLButtonElement>('importBtn').click();

      await vi.waitFor(() => expect(importResultsText()).toMatch(/truncated/));
    });

    it('shows the discovered account before importing anything', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([{ conversationId: 'c1', accountName: 'work@example.com' }]);
      await initWithDefaults();
      vi.mocked(sendMessage).mockResolvedValue({
        notePath: '/vault/note.md',
        anchorsPreserved: 0,
        anchorsIssued: 0,
        superseded: 0,
        skipped: null,
      });

      el<HTMLButtonElement>('importBtn').click();

      await vi.waitFor(() => expect(importResultsText()).toContain('work@example.com'));
    });

    it('words the completion summary as covering the signed-in account, not all accounts', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([{ conversationId: 'c1' }]);
      await initWithDefaults();
      vi.mocked(sendMessage).mockResolvedValue({
        notePath: '/vault/note.md',
        anchorsPreserved: 0,
        anchorsIssued: 0,
        superseded: 0,
        skipped: null,
      });
      // The test-wide chrome.i18n mock just echoes the key back, so the
      // real wording (asserted below) is supplied here for this one key.
      vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) =>
        key === 'popup_importComplete' ? 'Finished importing the signed-in account.' : key
      );

      el<HTMLButtonElement>('importBtn').click();

      await vi.waitFor(() => expect(importResultsText()).toMatch(/signed-in account/));
      expect(importResultsText()).not.toMatch(/all your conversations/i);
    });

    it("names every distinct account discovered, not just the first conversation's", async () => {
      // A single Claude login can enumerate multiple organizations, so the
      // banner must not silently speak for only conversations[0]'s org while
      // importing another org's conversations unannounced.
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([
        { conversationId: 'c1', accountId: 'org-1', accountName: 'Personal' },
        { conversationId: 'c2', accountId: 'org-2', accountName: 'Acme' },
      ]);
      await initWithDefaults();
      vi.mocked(sendMessage).mockResolvedValue({
        notePath: '/vault/note.md',
        anchorsPreserved: 0,
        anchorsIssued: 0,
        superseded: 0,
        skipped: null,
      });

      el<HTMLButtonElement>('importBtn').click();

      await vi.waitFor(() => {
        expect(importResultsText()).toContain('Personal');
        expect(importResultsText()).toContain('Acme');
      });
    });

    it('passes the import/skip counts to i18n as substitutions rather than concatenating raw English', async () => {
      stubActiveTab('https://claude.ai/chat/abc');
      stubDiscovery([{ conversationId: 'c1' }, { conversationId: 'c2' }]);
      await initWithDefaults();
      vi.mocked(sendMessage)
        .mockResolvedValueOnce({
          notePath: '/vault/note1.md',
          anchorsPreserved: 0,
          anchorsIssued: 0,
          superseded: 0,
          skipped: null,
        })
        .mockResolvedValueOnce({
          notePath: null,
          anchorsPreserved: 0,
          anchorsIssued: 0,
          superseded: 0,
          skipped: 'truncated',
        });

      el<HTMLButtonElement>('importBtn').click();

      // A hardcoded `${imported} imported, ${skipped} skipped.` fragment
      // concatenated onto a translated sentence would still read correctly
      // in English, so this asserts the mechanism (getMessage called with
      // the counts as substitutions), not just the rendered text — the only
      // way a future ja translation could ever localize these numbers'
      // surrounding words.
      await vi.waitFor(() => {
        expect(vi.mocked(chrome.i18n.getMessage)).toHaveBeenCalledWith('popup_importComplete', [
          '1',
          '1',
        ]);
      });
    });
  });
});
