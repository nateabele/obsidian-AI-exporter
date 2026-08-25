/**
 * Content script bootstrap tests
 *
 * Drives the REAL src/content/bootstrap.ts module (initialize, handleSync,
 * getExtractor, startContentScript) with mocked ui/messaging layers and
 * fixture DOM. The index.ts entry shim stays a 3-line side effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContentScriptSettings, MultiOutputResponse } from '../../src/lib/types';
import {
  loadFixture,
  clearFixture,
  createGeminiConversationDOM,
  setGeminiLocation,
  setNonGeminiLocation,
  resetLocation,
} from '../fixtures/dom-helpers';

vi.mock('../../src/content/ui', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../src/content/sync-icon', () => ({
  injectSyncIcon: vi.fn(),
  setSyncState: vi.fn(),
  deriveState: vi.fn(() => 'synced'),
  getSuggestionCount: vi.fn(() => 0),
}));

vi.mock('../../src/lib/messaging', () => ({
  sendMessage: vi.fn(),
}));

import {
  showSuccessToast,
  showErrorToast,
  showWarningToast,
  showToast,
} from '../../src/content/ui';
import { injectSyncIcon, setSyncState } from '../../src/content/sync-icon';
import { sendMessage } from '../../src/lib/messaging';
import { AUTO_SYNC_DEBOUNCE } from '../../src/lib/constants';
import type { ChatSyncResponse, MessageErrorResponse } from '../../src/lib/types';
import {
  initialize,
  handleSync,
  getExtractor,
  startContentScript,
  stopAutoSync,
  runAutoSync,
} from '../../src/content/bootstrap';
import { GeminiExtractor } from '../../src/content/extractors/gemini';

const baseSettings: ContentScriptSettings = {
  obsidianUrl: 'http://127.0.0.1:27123',
  vaultPath: 'AI/{platform}',
  isApiKeyConfigured: true,
  enableAutoScroll: false,
  enableAppendMode: false,
  enableToolContent: false,
  outputOptions: { obsidian: true, file: false, clipboard: false },
  templateOptions: {
    includeId: true,
    includeTitle: true,
    includeTags: true,
    includeSource: true,
    includeDates: true,
    includeMessageCount: true,
    messageFormat: 'callout',
    userCalloutType: 'QUESTION',
    assistantCalloutType: 'NOTE',
  },
};

const okSave: MultiOutputResponse = {
  results: [{ destination: 'obsidian', success: true }],
  allSuccessful: true,
  anySuccessful: true,
  messagesAppended: undefined,
};

const okChatSync: ChatSyncResponse = {
  notePath: 'AI/gemini/hello-gemini.md',
  mode: 'append',
  appended: 1,
  superseded: 0,
  suggestions: { transcripts: [], pages: [] },
};

/** Route mocked sendMessage responses by action */
function mockMessaging(overrides: {
  settings?: Partial<ContentScriptSettings>;
  connection?: { success: boolean; error?: string };
  save?: MultiOutputResponse;
  chatSync?: ChatSyncResponse | MessageErrorResponse;
}): void {
  vi.mocked(sendMessage).mockImplementation(message => {
    switch ((message as { action: string }).action) {
      case 'getSettings':
        return Promise.resolve({ ...baseSettings, ...overrides.settings });
      case 'testConnection':
        return Promise.resolve(overrides.connection ?? { success: true });
      case 'saveToOutputs':
        return Promise.resolve(overrides.save ?? okSave);
      case 'chatSync':
        return Promise.resolve(overrides.chatSync ?? okChatSync);
      default:
        return Promise.reject(new Error('unexpected action'));
    }
  });
}

function loadGeminiConversation(): void {
  setGeminiLocation('abc123def456');
  loadFixture(
    createGeminiConversationDOM([
      { role: 'user', content: 'Hello Gemini' },
      { role: 'assistant', content: '<p>Hi there!</p>' },
    ])
  );
}

describe('content/bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // A test's initialize() attaches an auto-sync MutationObserver to the
    // shared jsdom document; disconnect it before mutating the DOM below so
    // it doesn't fire against the next test's (already-reset) mocks.
    stopAutoSync();
    clearFixture();
    resetLocation();
  });

  describe('getExtractor', () => {
    it('returns the Gemini extractor on gemini.google.com', () => {
      setGeminiLocation('abc123');
      expect(getExtractor()?.platform).toBe('gemini');
    });

    it('returns null on unsupported hostnames', () => {
      setNonGeminiLocation('example.com');
      expect(getExtractor()).toBeNull();
    });

    it('rejects malicious subdomains embedding a platform hostname', () => {
      setNonGeminiLocation('gemini.google.com.attacker.com');
      expect(getExtractor()).toBeNull();
    });
  });

  describe('initialize', () => {
    it('skips initialization on unsupported pages', async () => {
      setNonGeminiLocation('example.com');
      await initialize();
      expect(injectSyncIcon).not.toHaveBeenCalled();
    });

    it('injects the sync icon on a Gemini conversation page', async () => {
      loadGeminiConversation();
      await initialize();
      expect(injectSyncIcon).toHaveBeenCalledTimes(1);
      expect(injectSyncIcon).toHaveBeenCalledWith(
        expect.objectContaining({
          onOpenOptions: expect.any(Function),
          onRetry: expect.any(Function),
          onSyncNow: expect.any(Function),
          onOpenPath: expect.any(Function),
        })
      );
    });
  });

  describe('conversation container waiting', () => {
    it('initializes once the container appears via MutationObserver', async () => {
      setGeminiLocation('abc123def456');
      // Observation root (main) exists, but no conversation container yet
      loadFixture('<main id="root"></main>');

      const pending = initialize();
      expect(injectSyncIcon).not.toHaveBeenCalled();

      // Container arrives later (lazy render)
      document.querySelector('main')!.innerHTML = createGeminiConversationDOM([
        { role: 'user', content: 'late' },
      ]);

      await pending;
      expect(injectSyncIcon).toHaveBeenCalledTimes(1);
    });

    it('falls back to document.body observation without a platform root', async () => {
      setGeminiLocation('abc123def456');
      loadFixture('<div id="no-main"></div>'); // no <main>, no #app-container

      const pending = initialize();
      document.body.insertAdjacentHTML(
        'beforeend',
        createGeminiConversationDOM([{ role: 'user', content: 'late' }])
      );

      await pending;
      expect(injectSyncIcon).toHaveBeenCalledTimes(1);
    });

    it('gives up waiting after the fallback timeout', async () => {
      vi.useFakeTimers();
      try {
        setGeminiLocation('abc123def456');
        loadFixture('<main></main>'); // container never appears

        const pending = initialize();
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;

        // Initialization still completes (icon injected on a bare page)
        expect(injectSyncIcon).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('auto-sync (debounced observer)', () => {
    /**
     * Stub the global MutationObserver so the test can drive the auto-sync
     * observer's callback directly (simulating a burst of streaming-response
     * mutations) instead of depending on jsdom's real mutation-record timing.
     * Safe here because the conversation container already exists before
     * initialize() runs, so waitForConversationContainer() never constructs
     * its own MutationObserver (see its early-return branch).
     */
    function stubMutationObserver(): {
      getCallback: () => MutationCallback;
      restore: () => void;
    } {
      const OriginalMutationObserver = globalThis.MutationObserver;
      let captured: MutationCallback | undefined;
      vi.stubGlobal(
        'MutationObserver',
        vi.fn(function MockMutationObserver(this: unknown, callback: MutationCallback) {
          captured = callback;
          return { observe: vi.fn(), disconnect: vi.fn() };
        })
      );
      return {
        getCallback: () => {
          if (!captured) throw new Error('MutationObserver was never constructed');
          return captured;
        },
        restore: () => vi.stubGlobal('MutationObserver', OriginalMutationObserver),
      };
    }

    it('collapses a burst of mutation callbacks into exactly one sync, after the quiet period settles', async () => {
      vi.useFakeTimers();
      const stub = stubMutationObserver();
      try {
        setGeminiLocation('auto-sync-burst');
        loadFixture(
          createGeminiConversationDOM([
            { role: 'user', content: 'Hello Gemini' },
            { role: 'assistant', content: '<p>Hi there!</p>' },
          ])
        );
        mockMessaging({
          settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        });

        await initialize();
        const callback = stub.getCallback();

        // Simulate rapid mutations arriving mid-stream (e.g. streamed tokens).
        callback([], {} as MutationObserver);
        callback([], {} as MutationObserver);
        callback([], {} as MutationObserver);

        // Only the settled state matters: no sync until the quiet period
        // has fully elapsed since the LAST mutation in the burst.
        await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE);

        const chatSyncCalls = vi
          .mocked(sendMessage)
          .mock.calls.filter(([message]) => (message as { action: string }).action === 'chatSync');
        expect(chatSyncCalls).toHaveLength(1);
      } finally {
        stub.restore();
        vi.useRealTimers();
      }
    });

    it('never fires a pending sync once stopAutoSync() has run', async () => {
      vi.useFakeTimers();
      const stub = stubMutationObserver();
      try {
        setGeminiLocation('auto-sync-cancel');
        loadFixture(
          createGeminiConversationDOM([
            { role: 'user', content: 'Hello Gemini' },
            { role: 'assistant', content: '<p>Hi there!</p>' },
          ])
        );
        mockMessaging({
          settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        });

        await initialize();
        const callback = stub.getCallback();

        callback([], {} as MutationObserver);
        stopAutoSync();
        await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE + 1000);

        const chatSyncCalls = vi
          .mocked(sendMessage)
          .mock.calls.filter(([message]) => (message as { action: string }).action === 'chatSync');
        expect(chatSyncCalls).toHaveLength(0);
      } finally {
        stub.restore();
        vi.useRealTimers();
      }
    });
  });

  describe('runAutoSync', () => {
    function chatSyncCallsOf(): unknown[] {
      return vi
        .mocked(sendMessage)
        .mock.calls.filter(([message]) => (message as { action: string }).action === 'chatSync');
    }

    it('does not advance the manifest after a failed sync, so the next attempt resends the same blocks', async () => {
      setGeminiLocation('auto-sync-retry');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );

      let chatSyncCallCount = 0;
      const sentManifests: string[][] = [];
      vi.mocked(sendMessage).mockImplementation(message => {
        const action = (message as { action: string }).action;
        if (action === 'getSettings') {
          return Promise.resolve({
            ...baseSettings,
            isCompanionConfigured: true,
            autoSyncPlatforms: ['gemini'],
          });
        }
        if (action === 'chatSync') {
          chatSyncCallCount += 1;
          sentManifests.push((message as { data: { manifest: string[] } }).data.manifest);
          const failure: MessageErrorResponse = { success: false, error: 'network blip' };
          return Promise.resolve(chatSyncCallCount === 1 ? failure : okChatSync);
        }
        return Promise.reject(new Error('unexpected action'));
      });

      await runAutoSync(); // fails
      await runAutoSync(); // same DOM, must resend the identical manifest/blocks

      expect(chatSyncCallCount).toBe(2);
      expect(sentManifests[1]).toEqual(sentManifests[0]);
    });

    it('returns without sending when a sync is already in flight', async () => {
      setGeminiLocation('auto-sync-inflight');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );

      let resolveGetSettings!: (value: ContentScriptSettings) => void;
      const pendingSettings = new Promise<ContentScriptSettings>(resolve => {
        resolveGetSettings = resolve;
      });

      let chatSyncCallCount = 0;
      vi.mocked(sendMessage).mockImplementation(message => {
        const action = (message as { action: string }).action;
        if (action === 'getSettings') return pendingSettings;
        if (action === 'chatSync') {
          chatSyncCallCount += 1;
          return Promise.resolve(okChatSync);
        }
        return Promise.reject(new Error('unexpected action'));
      });

      const first = runAutoSync(); // starts, suspends awaiting getSettings
      const second = runAutoSync(); // must see the in-flight guard and bail immediately

      await expect(second).resolves.toBeNull();

      resolveGetSettings({
        ...baseSettings,
        isCompanionConfigured: true,
        autoSyncPlatforms: ['gemini'],
      });
      await first;

      expect(chatSyncCallCount).toBe(1);
    });

    it('never triggers auto-scroll even when the user setting is enabled', async () => {
      setGeminiLocation('auto-sync-noscroll');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: {
          isCompanionConfigured: true,
          autoSyncPlatforms: ['gemini'],
          enableAutoScroll: true,
        },
      });

      const applySettingsSpy = vi.spyOn(GeminiExtractor.prototype, 'applySettings');
      try {
        await runAutoSync();

        expect(applySettingsSpy).toHaveBeenCalledWith(
          expect.objectContaining({ enableAutoScroll: false })
        );
      } finally {
        applySettingsSpy.mockRestore();
      }
    });

    it("does not send when the manifest's first hash diverges from a non-empty previousManifest (virtualization window guard)", async () => {
      setGeminiLocation('auto-sync-window');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Original first message' },
          { role: 'assistant', content: '<p>reply</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
      });

      await runAutoSync();
      expect(chatSyncCallsOf()).toHaveLength(1);

      // Same conversation (same href — no navigation), but the DOM now looks
      // like a virtualized window that dropped the true first message.
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'A completely different first message' },
          { role: 'assistant', content: '<p>reply</p>' },
        ])
      );

      await runAutoSync();
      expect(chatSyncCallsOf()).toHaveLength(1); // unchanged: the second attempt was refused
    });
  });

  describe('startContentScript', () => {
    it('initializes immediately when the DOM is already ready', async () => {
      loadGeminiConversation();
      startContentScript();
      await vi.waitFor(() => expect(injectSyncIcon).toHaveBeenCalled());
    });

    it('waits for DOMContentLoaded while the document is loading', async () => {
      loadGeminiConversation();
      Object.defineProperty(document, 'readyState', {
        value: 'loading',
        configurable: true,
      });
      try {
        startContentScript();
        expect(injectSyncIcon).not.toHaveBeenCalled();

        document.dispatchEvent(new Event('DOMContentLoaded'));
        await vi.waitFor(() => expect(injectSyncIcon).toHaveBeenCalled());
      } finally {
        Object.defineProperty(document, 'readyState', {
          value: 'complete',
          configurable: true,
        });
      }
    });

    it('logs initialization failures instead of throwing', async () => {
      loadGeminiConversation();
      vi.mocked(injectSyncIcon).mockImplementation(() => {
        throw new Error('inject failed');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startContentScript();
      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          '[G2O] Content script initialization failed:',
          expect.any(Error)
        )
      );
      errorSpy.mockRestore();
    });
  });

  describe('handleSync', () => {
    it('shows an error when no output destination is enabled', async () => {
      loadGeminiConversation();
      mockMessaging({
        settings: { outputOptions: { obsidian: false, file: false, clipboard: false } },
      });

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith(
        'Please select at least one output destination in settings'
      );
      expect(setSyncState).toHaveBeenLastCalledWith('offline', {
        error: 'Please select at least one output destination in settings',
      });
    });

    it('shows an error when Obsidian is enabled without an API key', async () => {
      loadGeminiConversation();
      mockMessaging({ settings: { isApiKeyConfigured: false } });

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith(
        'Please configure your Obsidian API key in the extension settings'
      );
    });

    it('shows the connection error when the connection test fails', async () => {
      loadGeminiConversation();
      mockMessaging({ connection: { success: false, error: 'Obsidian is not running' } });

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith('Obsidian is not running');
    });

    it('skips the connection test when Obsidian output is disabled', async () => {
      loadGeminiConversation();
      mockMessaging({
        settings: { outputOptions: { obsidian: false, file: true, clipboard: false } },
      });

      await handleSync();

      const actions = vi
        .mocked(sendMessage)
        .mock.calls.map(call => (call[0] as { action: string }).action);
      expect(actions).not.toContain('testConnection');
      expect(showSuccessToast).toHaveBeenCalled();
    });

    it('shows an error on unsupported pages', async () => {
      setNonGeminiLocation('example.com');
      mockMessaging({});

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith('Not on a valid conversation page');
    });

    it('shows an error when the page has no extractable conversation', async () => {
      setGeminiLocation('abc123def456');
      loadFixture('<div id="empty"></div>');
      mockMessaging({});

      await handleSync();

      expect(showErrorToast).toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'saveToOutputs' })
      );
    });

    it('extracts, saves, and shows success on the happy path', async () => {
      loadGeminiConversation();
      mockMessaging({});

      await handleSync();

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'saveToOutputs',
          outputs: ['obsidian'],
          data: expect.objectContaining({ fileName: expect.stringMatching(/\.md$/) }),
        })
      );
      expect(showSuccessToast).toHaveBeenCalledWith(expect.stringMatching(/\.md$/), true);
      expect(setSyncState).toHaveBeenNthCalledWith(1, 'syncing');
      expect(setSyncState).toHaveBeenLastCalledWith('synced', { suggestionCount: 0 });
    });

    it('shows the ACTUAL file name when a collision forced a rename (issue #327)', async () => {
      loadGeminiConversation();
      mockMessaging({
        save: {
          results: [{ destination: 'obsidian', success: true, savedAs: 'hello-a1b2c3d4.md' }],
          allSuccessful: true,
          anySuccessful: true,
        },
      });

      await handleSync();

      expect(showSuccessToast).toHaveBeenCalledWith('hello-a1b2c3d4.md', true);
    });

    it('shows the appended-message toast when messages were appended', async () => {
      loadGeminiConversation();
      mockMessaging({ save: { ...okSave, messagesAppended: 2 } });

      await handleSync();

      expect(showToast).toHaveBeenCalledWith('2 new message(s) appended', 'success');
    });

    it('shows the no-new-messages toast when nothing was appended', async () => {
      loadGeminiConversation();
      mockMessaging({ save: { ...okSave, messagesAppended: 0 } });

      await handleSync();

      expect(showToast).toHaveBeenCalledWith(
        'No new messages to append',
        'info',
        expect.any(Number)
      );
    });

    it('shows a warning when only some outputs succeed', async () => {
      loadGeminiConversation();
      mockMessaging({
        save: {
          results: [
            { destination: 'obsidian', success: true },
            { destination: 'clipboard', success: false, error: 'copy failed' },
          ],
          allSuccessful: false,
          anySuccessful: true,
        },
      });

      await handleSync();

      expect(showWarningToast).toHaveBeenCalledWith(
        'Saved to: obsidian. Failed: clipboard: copy failed'
      );
    });

    it('shows an error when every output fails', async () => {
      loadGeminiConversation();
      mockMessaging({
        save: {
          results: [{ destination: 'obsidian', success: false, error: 'disk full' }],
          allSuccessful: false,
          anySuccessful: false,
        },
      });

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith('disk full');
    });

    it('shows a generic error when failures carry no message', async () => {
      loadGeminiConversation();
      mockMessaging({
        save: {
          results: [{ destination: 'obsidian', success: false }],
          allSuccessful: false,
          anySuccessful: false,
        },
      });

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith('Failed to save');
    });

    it('catches messaging errors and resets the icon state', async () => {
      loadGeminiConversation();
      vi.mocked(sendMessage).mockRejectedValue(new Error('Extension context invalidated.'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleSync();

      expect(showErrorToast).toHaveBeenCalledWith('Extension context invalidated.');
      expect(setSyncState).toHaveBeenLastCalledWith('offline', {
        error: 'Extension context invalidated.',
      });
      errorSpy.mockRestore();
    });

    it('does not touch the icon state while a background auto-sync is in flight', async () => {
      loadGeminiConversation();

      let resolveGetSettings!: (value: ContentScriptSettings) => void;
      const pendingSettings = new Promise<ContentScriptSettings>(resolve => {
        resolveGetSettings = resolve;
      });
      vi.mocked(sendMessage).mockImplementation(message => {
        const action = (message as { action: string }).action;
        if (action === 'getSettings') return pendingSettings;
        if (action === 'chatSync') return Promise.resolve(okChatSync);
        return Promise.reject(new Error('unexpected action'));
      });

      // Starts runAutoSync and suspends it awaiting getSettings, which sets
      // the module-level autoSyncInFlight guard before handleSync ever runs.
      const autoSync = runAutoSync();

      vi.mocked(setSyncState).mockClear();
      mockMessaging({});
      await handleSync();

      expect(setSyncState).not.toHaveBeenCalled();

      resolveGetSettings({
        ...baseSettings,
        isCompanionConfigured: true,
        autoSyncPlatforms: ['gemini'],
      });
      await autoSync;
    });
  });
});
