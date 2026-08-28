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
  createClaudeConversationDOM,
  setGeminiLocation,
  setClaudeLocation,
  setNonGeminiLocation,
  resetLocation,
} from '../fixtures/dom-helpers';

vi.mock('../../src/content/ui', () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../src/content/archive/discover', () => ({
  registerArchiveDiscoveryListener: vi.fn(),
  fetchConversationForRepair: vi.fn(),
}));

vi.mock('../../src/content/sync-icon', async () => {
  // deriveState is wrapped around the REAL implementation (not stubbed to
  // always return 'synced') so tests can assert on both the arguments it's
  // called with and the state it actually derives from them — a stub that
  // ignores its input would let a wrong `configured`/`error` argument pass
  // silently, which is exactly how the round-3 bug (settleIcon asserting
  // `error: null` on paths that never checked) stayed invisible here.
  const actual = await vi.importActual<typeof import('../../src/content/sync-icon')>(
    '../../src/content/sync-icon'
  );
  return {
    injectSyncIcon: vi.fn(),
    paintFor: vi.fn(),
    deriveState: vi.fn(actual.deriveState),
    getSuggestionCount: vi.fn(() => 0),
    getLastError: vi.fn(() => null),
    setIconContext: vi.fn(),
    setSuggestions: vi.fn(),
    suggestionCount: vi.fn(() => 0),
  };
});

vi.mock('../../src/lib/messaging', () => ({
  sendMessage: vi.fn(),
}));

import {
  showSuccessToast,
  showErrorToast,
  showWarningToast,
  showToast,
} from '../../src/content/ui';
import {
  injectSyncIcon,
  paintFor,
  deriveState,
  getLastError,
  setIconContext,
  setSuggestions,
  suggestionCount,
} from '../../src/content/sync-icon';
import { sendMessage } from '../../src/lib/messaging';
import { fetchConversationForRepair } from '../../src/content/archive/discover';
import { AUTO_SYNC_DEBOUNCE } from '../../src/lib/constants';
import type {
  ChatSyncResponse,
  ChatBackfillRequest,
  ChatBackfillResponse,
  MessageErrorResponse,
} from '../../src/lib/types';
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
  chatBackfill?: ChatBackfillResponse | MessageErrorResponse;
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
      case 'chatBackfill':
        if (!overrides.chatBackfill) {
          return Promise.reject(new Error('unexpected action'));
        }
        return Promise.resolve(overrides.chatBackfill);
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

/** A Claude conversation id shaped to match extractors/claude.ts's getConversationId() regex. */
const CLAUDE_CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440000';

function loadClaudeConversation(): void {
  setClaudeLocation(CLAUDE_CONVERSATION_ID);
  loadFixture(
    createClaudeConversationDOM([
      { role: 'user', content: 'Hello Claude' },
      { role: 'assistant', content: 'Hi there!' },
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

    describe('onSyncNow handler', () => {
      it('drives the real companion sync (chatSync), not the legacy manual export (saveToOutputs)', async () => {
        loadGeminiConversation();
        mockMessaging({
          settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        });
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onSyncNow();
        await vi.waitFor(() => {
          const calls = vi
            .mocked(sendMessage)
            .mock.calls.filter(
              ([message]) => (message as { action: string }).action === 'chatSync'
            );
          expect(calls).toHaveLength(1);
        });

        expect(sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'saveToOutputs' })
        );
      });
    });

    describe('onOpenPath handler', () => {
      /** The real onOpenPath closure injectSyncIcon() was called with. */
      async function getOnOpenPath(): Promise<(path: string) => void> {
        loadGeminiConversation();
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];
        return handlers.onOpenPath;
      }

      it('sends openInObsidian with the given path', async () => {
        const onOpenPath = await getOnOpenPath();
        vi.mocked(sendMessage).mockResolvedValue({ success: true });

        onOpenPath('AI/claude/related-conversation.md');

        expect(sendMessage).toHaveBeenCalledWith({
          action: 'openInObsidian',
          data: { path: 'AI/claude/related-conversation.md' },
        });
      });

      it('does nothing for an empty path (no note synced yet)', async () => {
        const onOpenPath = await getOnOpenPath();

        onOpenPath('');

        expect(sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'openInObsidian' })
        );
      });

      // sendMessage() resolves — never rejects — for both realistic failure
      // modes below: openNote() throwing (companion offline) and a non-OK
      // response (invalid path) are both converted into a resolved
      // `{ success: false, error }` by the service worker's listener before
      // ever reaching the content script. A rejected promise only happens
      // for a genuinely different failure (extension context invalidated,
      // covered separately below), so these must resolve with a failure
      // shape rather than reject to actually exercise onOpenPath's check of
      // the resolved value.
      it('shows an error toast when the companion is unreachable', async () => {
        const onOpenPath = await getOnOpenPath();
        vi.mocked(sendMessage).mockResolvedValue({
          success: false,
          error: 'Companion token is not configured',
        });

        onOpenPath('AI/claude/related-conversation.md');

        await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalled());
        expect(showErrorToast).toHaveBeenCalledWith('Companion token is not configured');
      });

      it('shows an error toast when the companion rejects the path (400)', async () => {
        const onOpenPath = await getOnOpenPath();
        vi.mocked(sendMessage).mockResolvedValue({
          success: false,
          error: 'Companion open failed (400): invalid path',
        });

        onOpenPath('AI/claude/related-conversation.md');

        await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalled());
        expect(showErrorToast).toHaveBeenCalledWith('Companion open failed (400): invalid path');
      });

      it('shows an error toast when sendMessage itself rejects (e.g. extension context invalidated)', async () => {
        const onOpenPath = await getOnOpenPath();
        vi.mocked(sendMessage).mockRejectedValue(new Error('Extension context invalidated'));

        onOpenPath('AI/claude/related-conversation.md');

        await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalled());
        expect(showErrorToast).toHaveBeenCalledWith('Extension context invalidated');
      });
    });

    describe('onRepair handler', () => {
      const backfillRequest: ChatBackfillRequest = {
        conversationId: CLAUDE_CONVERSATION_ID,
        platform: 'claude',
        title: 'Repaired conversation',
        url: `https://claude.ai/chat/${CLAUDE_CONVERSATION_ID}`,
        createdAt: '2026-01-01T00:00:00Z',
        accountId: 'org-1',
        accountName: 'Personal',
        messages: [
          { role: 'user', markdown: 'Hello Claude', hash: 'h1', sourceId: 'm1' },
          { role: 'assistant', markdown: 'Hi there!', hash: 'h2', sourceId: 'm2' },
        ],
      };

      it('is not offered on a platform with no ArchiveAdapter (e.g. Gemini)', async () => {
        loadGeminiConversation();
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        expect(handlers.onRepair).toBeUndefined();
      });

      it('is offered on a platform with a working ArchiveAdapter (e.g. Claude)', async () => {
        loadClaudeConversation();
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        expect(handlers.onRepair).toEqual(expect.any(Function));
      });

      it('canRepair reports true when the current page has a resolvable conversation id', async () => {
        loadClaudeConversation();
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        expect(handlers.canRepair!()).toBe(true);
      });

      it('canRepair reports false so the menu entry is not offered when no conversation id is resolvable, even on a supported platform', async () => {
        setClaudeLocation('');
        loadFixture(createClaudeConversationDOM([{ role: 'user', content: 'Hello Claude' }]));
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        expect(handlers.onRepair).toEqual(expect.any(Function));
        expect(handlers.canRepair!()).toBe(false);
      });

      it('fetches, converts, and backfills the current conversation, then paints the icon from the response', async () => {
        loadClaudeConversation();
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillRequest);
        mockMessaging({
          chatBackfill: {
            notePath: 'AI/claude/repaired-conversation.md',
            anchorsPreserved: 2,
            anchorsIssued: 0,
            superseded: 0,
            skipped: null,
          },
        });
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();

        expect(fetchConversationForRepair).toHaveBeenCalledWith(CLAUDE_CONVERSATION_ID);
        await vi.waitFor(() =>
          expect(sendMessage).toHaveBeenCalledWith({
            action: 'chatBackfill',
            data: backfillRequest,
          })
        );
        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(
            location.href,
            expect.any(String),
            expect.objectContaining({
              notePath: 'AI/claude/repaired-conversation.md',
              error: null,
            })
          )
        );
        // Never painted via setSyncState directly across the fetch/send
        // awaits — see test/arch/sync-icon-invariants.test.ts.
        expect(paintFor).toHaveBeenCalledWith(location.href, 'syncing');
        // Exactly one backfill request per repair click — nothing here
        // should retry or double-send on a normal success path.
        expect(
          vi.mocked(sendMessage).mock.calls.filter(([msg]) => msg.action === 'chatBackfill')
        ).toHaveLength(1);
      });

      it('treats a skipped response as a normal outcome, not a failure', async () => {
        loadClaudeConversation();
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillRequest);
        mockMessaging({
          chatBackfill: {
            notePath: null,
            anchorsPreserved: 0,
            anchorsIssued: 0,
            superseded: 0,
            skipped: 'truncated',
          },
        });
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();

        await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
        // chrome.i18n.getMessage is stubbed in test/setup.ts to return the
        // raw key (ignoring substitutions), so this asserts the reason was
        // passed through to chrome.i18n.getMessage() rather than on the
        // rendered copy.
        expect(vi.mocked(chrome.i18n.getMessage)).toHaveBeenCalledWith('syncIcon_repairSkipped', [
          'truncated',
        ]);
        expect(showToast).toHaveBeenCalledWith('syncIcon_repairSkipped', 'info');
        // A skip must not land on 'offline' -- see repairConversation()'s
        // comment on why the retained `error` field is never used for it.
        expect(paintFor).not.toHaveBeenCalledWith(location.href, 'offline', expect.anything());
      });

      it('paints the icon offline, visibly, when the server rejects the backfill', async () => {
        loadClaudeConversation();
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillRequest);
        mockMessaging({ chatBackfill: { error: 'Companion is offline' } });
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();

        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(location.href, 'offline', {
            error: 'Companion is offline',
          })
        );
        // A repair was explicitly clicked to fix a bad transcript — quietly
        // doing nothing on failure is exactly the failure mode it exists to
        // correct, so an icon tooltip alone isn't enough (brief requirement
        // 5): it must also surface as a toast, the same as handleSync's.
        expect(showErrorToast).toHaveBeenCalledWith('Companion is offline');
      });

      it('paints the icon offline, visibly, when fetching the conversation from source throws', async () => {
        loadClaudeConversation();
        vi.mocked(fetchConversationForRepair).mockRejectedValue(
          new Error('Claude API request failed (401)')
        );
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();

        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(location.href, 'offline', {
            error: 'Claude API request failed (401)',
          })
        );
        expect(sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'chatBackfill' })
        );
        expect(showErrorToast).toHaveBeenCalledWith('Claude API request failed (401)');
      });

      it('does not show the skip toast after an in-app navigation away mid-fetch, matching the icon paint guard', async () => {
        loadClaudeConversation();
        const startHref = location.href;
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillRequest);
        let resolveBackfill!: (response: ChatBackfillResponse) => void;
        vi.mocked(sendMessage).mockImplementation(
          () =>
            new Promise(resolve => {
              resolveBackfill = resolve;
            })
        );
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

        // Navigate to a different conversation before the server responds.
        setClaudeLocation('11111111-1111-1111-1111-111111111111');
        resolveBackfill({
          notePath: null,
          anchorsPreserved: 0,
          anchorsIssued: 0,
          superseded: 0,
          skipped: 'truncated',
        });

        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(startHref, 'synced', expect.anything())
        );
        // The stale-result-lands-on-the-wrong-conversation bug the icon's
        // paintFor() convention exists to prevent, but in a channel that
        // convention doesn't cover: a toast about conversation A's outcome
        // must not render on conversation B's page.
        expect(showToast).not.toHaveBeenCalled();
      });

      it('does not show an error toast after an in-app navigation away mid-fetch', async () => {
        loadClaudeConversation();
        const startHref = location.href;
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillRequest);
        let rejectBackfill!: (error: Error) => void;
        vi.mocked(sendMessage).mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectBackfill = reject;
            })
        );
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

        setClaudeLocation('11111111-1111-1111-1111-111111111111');
        rejectBackfill(new Error('Claude API request failed (401)'));

        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(startHref, 'offline', expect.anything())
        );
        expect(showErrorToast).not.toHaveBeenCalled();
      });

      it('paints the icon offline, visibly, when no conversation id is resolvable on the current page', async () => {
        setClaudeLocation('');
        loadFixture(createClaudeConversationDOM([{ role: 'user', content: 'Hello Claude' }]));
        await initialize();
        const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

        handlers.onRepair!();

        expect(paintFor).toHaveBeenCalledWith(
          location.href,
          'offline',
          expect.objectContaining({ error: expect.any(String) })
        );
        expect(fetchConversationForRepair).not.toHaveBeenCalled();
      });
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

    it('resends once with every block when the server asks for full content', async () => {
      setGeminiLocation('needs-full-content');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({ settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] } });
      await runAutoSync(); // establishes a 2-message baseline

      // Grow the conversation by one message so the next diff would
      // normally only cover the new tail — the full resend below must
      // cover every message instead, not just that diff.
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
          { role: 'user', content: 'Second question' },
        ])
      );

      let chatSyncCallCount = 0;
      const sentNewBlockCounts: number[] = [];
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
          const data = (message as { data: { newBlocks: unknown[] } }).data;
          sentNewBlockCounts.push(data.newBlocks.length);
          return Promise.resolve(
            chatSyncCallCount === 1
              ? { ...okChatSync, mode: 'needsFullContent' as const }
              : okChatSync
          );
        }
        return Promise.reject(new Error('unexpected action'));
      });

      const result = await runAutoSync();

      expect(chatSyncCallCount).toBe(2);
      expect(sentNewBlockCounts[0]).toBe(1); // the diffed tail message only
      expect(sentNewBlockCounts[1]).toBe(3); // the full resend covers every message
      expect(result).toEqual(okChatSync);
    });

    it('treats a second needsFullContent in the same attempt as a failure, without looping', async () => {
      setGeminiLocation('needs-full-content-loop');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );

      let chatSyncCallCount = 0;
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
          return Promise.resolve({ ...okChatSync, mode: 'needsFullContent' as const });
        }
        return Promise.reject(new Error('unexpected action'));
      });

      const result = await runAutoSync();

      expect(chatSyncCallCount).toBe(2); // exactly one retry, never a loop
      expect(result).toBeNull();
      expect(paintFor).toHaveBeenLastCalledWith(
        location.href,
        'offline',
        expect.objectContaining({ error: expect.any(String) })
      );
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

    it('updates the icon context immediately when a navigation arrives while a previous run is still in flight, so it is not lost behind the in-flight guard', async () => {
      // Regression pin for the round-5 audit: the href check used to sit
      // BELOW the in-flight guard, so a navigation arriving mid-run would
      // return null (swallowed) without ever updating the context. Moving
      // the check above the guard means the context updates synchronously
      // on every call, in-flight or not — only the actual sync work is
      // gated by the guard.
      setGeminiLocation('inflight-nav-a');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      const hrefA = location.href;

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

      const first = runAutoSync(); // starts, suspends awaiting getSettings, under hrefA

      // A navigation arrives (e.g. the debounced mutation observer fires
      // again) while the first run is still in flight.
      setGeminiLocation('inflight-nav-b');
      const hrefB = location.href;
      vi.mocked(setIconContext).mockClear();

      const second = runAutoSync();
      await expect(second).resolves.toBeNull(); // still swallowed by the in-flight guard...

      // ...but the context update itself must not be swallowed with it.
      expect(setIconContext).toHaveBeenCalledWith(hrefB);

      resolveGetSettings({
        ...baseSettings,
        isCompanionConfigured: true,
        autoSyncPlatforms: ['gemini'],
      });
      await first;

      // Every paint the first (now-stale) run caused must still carry
      // hrefA, never hrefB — dropping it is paintFor's job (backed by the
      // real module's context, now at hrefB), not runAutoSync's job to
      // pre-empt.
      for (const call of vi.mocked(paintFor).mock.calls) {
        expect(call[0]).toBe(hrefA);
        expect(call[0]).not.toBe(hrefB);
      }
    });

    it('settles the icon to a resting state on the unchanged-manifest early return, not stuck on syncing', async () => {
      // Regression pin: handleSync's reportSyncOutcome() defers entirely to
      // an in-flight runAutoSync on the assumption that it will always leave
      // the icon in a terminal state. That assumption only holds if every
      // early return in runAutoSync reports one — including the common
      // "manifest unchanged" case, which used to return null without
      // touching the icon at all, leaving it stuck on 'syncing' forever if
      // a manual sync had set that state right before this fired.
      setGeminiLocation('auto-sync-unchanged-icon');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
      });

      // Establishes previousManifest for the current (unchanging) DOM, so
      // the next run below takes the unchanged-manifest early return.
      await runAutoSync();
      vi.mocked(paintFor).mockClear();

      await runAutoSync(); // same DOM: takes the unchanged-manifest early return

      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'synced');
    });

    it('keeps the icon offline with the original error intact through a later unchanged-manifest auto-sync tick', async () => {
      // Regression pin for the third variant of the same bug: settleIcon
      // must not assert `error: null` on a bail-out that never checked for
      // one, or it silently clears a real, still-unresolved error left by a
      // prior failed manual sync the next time a routine background tick
      // (e.g. unchanged manifest) fires.
      setGeminiLocation('auto-sync-offline-retained');
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
          outputOptions: { obsidian: false, file: false, clipboard: false },
        },
      });

      // A manual "Sync now" fails because no output destination is enabled,
      // leaving the icon offline with an error.
      await handleSync();
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
        error: 'Please select at least one output destination in settings',
      });

      // paintFor is mocked here, so it never actually updates the real
      // module's retained lastError — stand in for what the real module
      // would have retained after the call above.
      vi.mocked(getLastError).mockReturnValue(
        'Please select at least one output destination in settings'
      );

      try {
        // Establishes previousManifest for the current (unchanging) DOM, so
        // the next run below takes the unchanged-manifest early return.
        await runAutoSync();
        vi.mocked(paintFor).mockClear();
        vi.mocked(deriveState).mockClear();

        await runAutoSync(); // same DOM: takes the unchanged-manifest early return

        expect(deriveState).toHaveBeenLastCalledWith({
          configured: true,
          syncing: false,
          error: 'Please select at least one output destination in settings',
          suggestionCount: 0,
        });
        expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline');
      } finally {
        vi.mocked(getLastError).mockReturnValue(null);
      }
    });

    it("resets retained icon detail on in-app navigation to a new conversation, so a bail-out there does not surface the previous conversation's stale error", async () => {
      // Regression pin for the fourth variant of the same root cause — a
      // state transition (here, the href-change branch) that resets the
      // baseline it owns (previousManifest) but not the retained icon
      // detail (error/note path/suggestion count) that travels with it.
      // Without setIconContext(), a failed manual sync in conversation A
      // leaves lastError set; navigating in-app to conversation B and
      // hitting any bail-out there (e.g. B has no messages yet) would
      // settle the icon offline with A's error against a conversation that
      // was never attempted.
      setGeminiLocation('auto-sync-nav-a');
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
          outputOptions: { obsidian: false, file: false, clipboard: false },
        },
      });

      // A manual "Sync now" fails in conversation A, leaving the icon
      // offline with A's error.
      await handleSync();
      const hrefA = location.href;
      expect(paintFor).toHaveBeenLastCalledWith(hrefA, 'offline', {
        error: 'Please select at least one output destination in settings',
      });

      // paintFor is mocked here, so it never actually updates the real
      // module's retained lastError — stand in for what the real module
      // would have retained after the call above (same pattern as the
      // sibling test above).
      vi.mocked(getLastError).mockReturnValue(
        'Please select at least one output destination in settings'
      );

      try {
        // In-app navigation to a brand-new, empty conversation B — no
        // reload, so only location.href changes.
        setGeminiLocation('auto-sync-nav-b');
        const hrefB = location.href;
        clearFixture();
        loadFixture(createGeminiConversationDOM([]));

        expect(setIconContext).not.toHaveBeenCalled();
        await runAutoSync(); // B has no messages: extract() fails, settleIcon(true) bail-out
        expect(setIconContext).toHaveBeenCalledWith(hrefB);
        expect(setIconContext).toHaveBeenCalledTimes(1);

        // setIconContext is mocked, so mirror its real effect (clearing
        // the retained error) here, same stand-in as above.
        vi.mocked(getLastError).mockReturnValue(null);

        vi.mocked(paintFor).mockClear();
        vi.mocked(deriveState).mockClear();
        await runAutoSync(); // same empty DOM, same href: routine bail-out only

        expect(deriveState).toHaveBeenLastCalledWith({
          configured: true,
          syncing: false,
          error: null,
          suggestionCount: 0,
        });
        expect(paintFor).toHaveBeenLastCalledWith(hrefB, 'synced');
        // Already inside conversation B — no further reset on this tick.
        expect(setIconContext).toHaveBeenCalledTimes(1);
      } finally {
        vi.mocked(getLastError).mockReturnValue(null);
      }
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

    it('does not advance the baseline and paints offline when the server no-ops a non-empty delta (reload stall)', async () => {
      // Regression pin: after a page reload, previousManifest is empty in
      // this fresh module instance, so the window guard in
      // shouldSendManifest() can't fire — the client sends a (possibly
      // windowed) manifest with a non-empty newBlocks. If the server
      // rejects it as a no-op (its own index-0 guard), a client that
      // ignores `response.mode` would advance previousManifest anyway and
      // paint green, permanently no-opping every later sync.
      setGeminiLocation('auto-sync-stall');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        chatSync: { ...okChatSync, mode: 'noop' },
      });

      await runAutoSync();

      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
        error: expect.any(String),
      });

      // The baseline must not have advanced: a second run against the same
      // (still-unsynced) DOM must attempt to send again, not take the
      // unchanged-manifest early return.
      vi.mocked(paintFor).mockClear();
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        chatSync: okChatSync,
      });
      await runAutoSync();
      expect(chatSyncCallsOf()).toHaveLength(2);
    });

    it('still settles normally on a genuine noop for an empty delta', async () => {
      // Contrast case: a `noop` response to an EMPTY newBlocks (nothing new
      // to actually append) is a real, routine outcome — not a stall — and
      // must not be treated as an error. Constructed via a manifest that
      // shrinks (same leading message, fewer trailing ones) so the window
      // guard still lets it through but diffBlocks() computes an empty
      // delta, mirroring what the server would legitimately no-op.
      setGeminiLocation('auto-sync-genuine-noop');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
          { role: 'user', content: 'Second question' },
          { role: 'assistant', content: '<p>Second answer</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        chatSync: okChatSync,
      });
      await runAutoSync(); // establishes the 4-message baseline

      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        chatSync: { ...okChatSync, mode: 'noop' },
      });
      vi.mocked(paintFor).mockClear();

      await runAutoSync();

      expect(paintFor).not.toHaveBeenCalledWith(
        location.href,
        'offline',
        expect.objectContaining({ error: expect.any(String) })
      );
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'synced', expect.anything());
    });

    it('records the suggestions from a successful response and paints the icon with their combined count', async () => {
      setGeminiLocation('auto-sync-suggestions');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      const suggestions = {
        transcripts: [{ kind: 'transcript' as const, title: 'A related chat', path: 'a.md' }],
        pages: [{ kind: 'topic' as const, title: 'A related topic', path: 'b.md' }],
      };
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
        chatSync: { ...okChatSync, suggestions },
      });
      vi.mocked(suggestionCount).mockReturnValue(2);

      try {
        await runAutoSync();

        expect(setSuggestions).toHaveBeenCalledWith(location.href, suggestions);
        expect(deriveState).toHaveBeenLastCalledWith({
          configured: true,
          syncing: false,
          error: null,
          suggestionCount: 2,
        });
        expect(paintFor).toHaveBeenLastCalledWith(location.href, 'suggestions', {
          suggestionCount: 2,
          notePath: okChatSync.notePath,
          error: null,
        });
      } finally {
        vi.mocked(suggestionCount).mockReturnValue(0);
      }
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
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
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
      expect(paintFor).toHaveBeenNthCalledWith(1, location.href, 'syncing');
      expect(deriveState).toHaveBeenLastCalledWith({
        configured: true,
        syncing: false,
        error: null,
        suggestionCount: 0,
      });
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'synced', {
        suggestionCount: 0,
        error: null,
      });
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
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
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

      vi.mocked(paintFor).mockClear();
      mockMessaging({});
      await handleSync();

      expect(paintFor).not.toHaveBeenCalled();

      resolveGetSettings({
        ...baseSettings,
        isCompanionConfigured: true,
        autoSyncPlatforms: ['gemini'],
      });
      await autoSync;
    });

    it('threads the href captured at entry through every paint it causes, even after an in-app navigation before it resolves', async () => {
      // Regression pin for the round-5 audit: a manual sync started on
      // conversation A that resolves after an in-app navigation to B must
      // never let its outcome land on B's icon. handleSync/trySync/
      // performSync/reportSyncOutcome have no navigation awareness of their
      // own — the guarantee comes entirely from capturing startHref once,
      // up front, and threading that same literal value through every paint
      // regardless of what location.href has since become. Dropping a paint
      // whose href no longer matches the current context is paintFor's job
      // (real module, covered in sync-icon.test.ts); this test proves
      // bootstrap.ts holds up its end by never substituting the now-current
      // href for the one the sync actually started under.
      loadGeminiConversation();
      const hrefA = location.href;

      let resolveGetSettings!: (value: ContentScriptSettings) => void;
      const pendingSettings = new Promise<ContentScriptSettings>(resolve => {
        resolveGetSettings = resolve;
      });
      vi.mocked(sendMessage).mockImplementation(message => {
        const action = (message as { action: string }).action;
        if (action === 'getSettings') return pendingSettings;
        if (action === 'testConnection') return Promise.resolve({ success: true });
        if (action === 'saveToOutputs') return Promise.resolve(okSave);
        return Promise.reject(new Error('unexpected action'));
      });

      const sync = handleSync(); // suspends awaiting getSettings, under hrefA
      expect(paintFor).toHaveBeenCalledWith(hrefA, 'syncing');

      // In-app navigation to B arrives before the settings promise resolves.
      setGeminiLocation('handle-sync-nav-b');
      const hrefB = location.href;

      resolveGetSettings({
        ...baseSettings,
        outputOptions: { obsidian: true, download: false, clipboard: false },
      });
      await sync;

      for (const call of vi.mocked(paintFor).mock.calls) {
        expect(call[0]).toBe(hrefA);
        expect(call[0]).not.toBe(hrefB);
      }
    });
  });
});
