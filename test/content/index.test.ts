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
  createChatGPTConversationDOM,
  setGeminiLocation,
  setClaudeLocation,
  setChatGPTLocation,
  setNonGeminiLocation,
  defineLocation,
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
    // Must return a stop function, like the real one: bootstrap retains it and
    // calls it to re-arm, so a bare vi.fn() (returning undefined) would throw
    // into runAutoSync's catch and turn every successful sync into `offline`.
    attachWatermarkWatcher: vi.fn(() => vi.fn()),
    deriveState: vi.fn(actual.deriveState),
    getSuggestionCount: vi.fn(() => 0),
    getLastError: vi.fn(() => null),
    getLastBlockedReason: vi.fn(() => null),
    recordSyncAttempt: vi.fn(),
    getLastAttempt: vi.fn(() => null),
    setIconContext: vi.fn(),
    setSuggestions: vi.fn(),
    suggestionCount: vi.fn(() => 0),
  };
});

vi.mock('../../src/content/conversation-watcher', async importOriginal => {
  // Wrapped around the REAL watcher rather than stubbed: the navigation tests
  // need its actual href/id comparison to decide when to fire, while the
  // teardown test needs to see that bootstrap called the stop function it was
  // handed back — so that stop is itself a spy. A stub would pin neither.
  const actual = await importOriginal<typeof import('../../src/content/conversation-watcher')>();
  return {
    ...actual,
    startConversationWatcher: vi.fn(
      (params: Parameters<typeof actual.startConversationWatcher>[0]) =>
        vi.fn(actual.startConversationWatcher(params))
    ),
  };
});

vi.mock('../../src/lib/messaging', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/lib/messaging')>()),
  sendMessage: vi.fn(),
}));

import {
  showSuccessToast,
  showErrorToast,
  showWarningToast,
  showToast,
} from '../../src/content/ui';
import {
  attachWatermarkWatcher,
  injectSyncIcon,
  paintFor,
  deriveState,
  getLastError,
  getLastBlockedReason,
  getLastAttempt,
  recordSyncAttempt,
  setIconContext,
  setSuggestions,
  suggestionCount,
} from '../../src/content/sync-icon';
import { sendMessage } from '../../src/lib/messaging';
import { fetchConversationForRepair } from '../../src/content/archive/discover';
import { startConversationWatcher } from '../../src/content/conversation-watcher';
import { AUTO_SYNC_DEBOUNCE, CONVERSATION_POLL_INTERVAL } from '../../src/lib/constants';
import type {
  ChatSyncRequest,
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

    describe('onSyncAndOpenTranscript handler', () => {
      /**
       * The real onSyncAndOpenTranscript closure injectSyncIcon() was called
       * with. A fresh conversation id per test: previousManifest is module
       * state, so reusing an href another test already synced would make the
       * sync here a no-op with no note path to open.
       */
      async function getHandler(conversationId: string): Promise<() => void> {
        setGeminiLocation(conversationId);
        loadFixture(
          createGeminiConversationDOM([
            { role: 'user', content: 'Hello Gemini' },
            { role: 'assistant', content: '<p>Hi there!</p>' },
          ])
        );
        await initialize();
        return vi.mocked(injectSyncIcon).mock.calls[0][0].onSyncAndOpenTranscript;
      }

      // vi.clearAllMocks() (test/setup.ts) clears recorded calls but keeps a
      // queued return value, so a getLastAttempt stub set below would
      // otherwise leak into the next test's fallback assertion.
      afterEach(() => {
        vi.mocked(getLastAttempt).mockReturnValue(null);
      });

      it('syncs for a path, then opens the note the response names', async () => {
        mockMessaging({
          settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
          chatSync: { ...okChatSync, notePath: 'AI/gemini/named-by-the-response.md' },
        });
        const onSyncAndOpenTranscript = await getHandler('open-transcript-via-sync');

        onSyncAndOpenTranscript();

        await vi.waitFor(() =>
          expect(sendMessage).toHaveBeenCalledWith({
            action: 'openInObsidian',
            data: { path: 'AI/gemini/named-by-the-response.md' },
          })
        );
      });

      it('reports why it cannot, rather than silently doing nothing', async () => {
        // Unconfigured, so runAutoSync bails before any request and no
        // response can name a path. The record that bail-out leaves behind is
        // what the user gets told.
        mockMessaging({ settings: { isCompanionConfigured: false } });
        vi.mocked(getLastAttempt).mockReturnValue({
          at: Date.now(),
          trigger: 'manual',
          outcome: 'blocked',
          sent: 0,
          appended: 0,
          superseded: 0,
          detail: 'syncIcon_notConfigured',
        });
        const onSyncAndOpenTranscript = await getHandler('open-transcript-unconfigured');

        onSyncAndOpenTranscript();

        await vi.waitFor(() =>
          expect(showErrorToast).toHaveBeenCalledWith('syncIcon_notConfigured')
        );
        expect(sendMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'openInObsidian' })
        );
      });

      it('falls back to a generic reason when the bail-out left none', async () => {
        // getLastAttempt/getLastError/getLastBlockedReason are all null here,
        // which is the one case with nothing specific to say — it must still
        // say something.
        mockMessaging({ settings: { isCompanionConfigured: false } });
        const onSyncAndOpenTranscript = await getHandler('open-transcript-no-reason');

        onSyncAndOpenTranscript();

        await vi.waitFor(() =>
          expect(showErrorToast).toHaveBeenCalledWith('syncIcon_transcriptUnavailable')
        );
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
              // A confirmed success resolves the `blocked` dimension as well,
              // or a "the conversation grew" reason from before the repair
              // would sit in the tooltip under a tick (see sendChatSync).
              blocked: null,
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
        // It does still resolve both retained dimensions, the same way the
        // non-skipped success below does: the repair ran, so a blockage a
        // previous tick recorded is answered.
        await vi.waitFor(() =>
          expect(paintFor).toHaveBeenCalledWith(
            location.href,
            expect.any(String),
            expect.objectContaining({ error: null, blocked: null })
          )
        );
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

  describe('auto-sync (navigation watcher)', () => {
    /** The chatSync requests sent so far. */
    function chatSyncCalls(): unknown[] {
      return vi
        .mocked(sendMessage)
        .mock.calls.filter(([message]) => (message as { action: string }).action === 'chatSync');
    }

    /** A fresh conversation per test — previousManifest is module state. */
    function loadConversation(conversationId: string): void {
      setGeminiLocation(conversationId);
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
    }

    const configured = { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] };

    it('syncs a conversation it was navigated to, with no DOM mutation at all', async () => {
      vi.useFakeTimers();
      try {
        loadConversation('aaa111');
        mockMessaging({ settings: configured });
        await initialize();
        // Nothing has synced yet: initialize() attaches the triggers, it does
        // not fire one.
        expect(chatSyncCalls()).toHaveLength(0);

        // Navigation ONLY: the URL moves to another conversation and the DOM is
        // left byte-identical, so nothing the MutationObserver watches happens.
        setGeminiLocation('bbb222');
        await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_INTERVAL);

        expect(chatSyncCalls()).toHaveLength(1);
        expect(recordSyncAttempt).toHaveBeenCalledWith(
          location.href,
          expect.objectContaining({ trigger: 'navigation' })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not sync when navigation lands on a page with no conversation', async () => {
      vi.useFakeTimers();
      try {
        loadConversation('ccc333');
        mockMessaging({ settings: configured });
        await initialize();

        // Gemini's bare /app. An extractor still exists here and canExtract()
        // is still true (it only re-checks the hostname), so the null
        // conversation id is the only thing that can stop the sync.
        defineLocation('gemini.google.com', '/app');
        await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_INTERVAL * 3);

        expect(chatSyncCalls()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops the navigation watcher on teardown', async () => {
      vi.useFakeTimers();
      try {
        loadConversation('ddd444');
        mockMessaging({ settings: configured });
        await initialize();

        stopAutoSync();

        // Pinned on the stop function bootstrap was actually handed back, not
        // merely on the absence of a later sync: a stop call that was never
        // wired up passed this entire suite once already.
        expect(vi.mocked(startConversationWatcher).mock.results[0].value).toHaveBeenCalledTimes(1);

        setGeminiLocation('eee555');
        await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_INTERVAL * 3);
        expect(chatSyncCalls()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops a navigation that arrives while a sync is still in flight', async () => {
      vi.useFakeTimers();
      try {
        loadConversation('ccc888');
        let releaseSync: (response: ChatSyncResponse) => void = () => {};
        vi.mocked(sendMessage).mockImplementation(message => {
          switch ((message as { action: string }).action) {
            case 'getSettings':
              return Promise.resolve({ ...baseSettings, ...configured });
            case 'chatSync':
              return new Promise<ChatSyncResponse>(resolve => {
                releaseSync = resolve;
              });
            default:
              return Promise.reject(new Error('unexpected action'));
          }
        });
        await initialize();

        // A sync parked on its chatSync round trip, so autoSyncInFlight is set.
        const inFlight = runAutoSync('manual');
        await vi.advanceTimersByTimeAsync(0);
        expect(chatSyncCalls()).toHaveLength(1);

        setGeminiLocation('ccc999');
        await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_INTERVAL);

        // The navigation must not race previousManifest with the run that owns
        // it; the next mutation re-triggers once this one finishes.
        expect(chatSyncCalls()).toHaveLength(1);
        releaseSync(okChatSync);
        await inFlight;
      } finally {
        vi.useRealTimers();
      }
    });

    it('replaces the previous watcher instead of stacking a second interval', async () => {
      vi.useFakeTimers();
      try {
        loadConversation('fff666');
        mockMessaging({ settings: configured });
        await initialize();
        await initialize();

        expect(startConversationWatcher).toHaveBeenCalledTimes(2);
        expect(vi.mocked(startConversationWatcher).mock.results[0].value).toHaveBeenCalledTimes(1);

        // One watcher left running, so one sync — not two.
        setGeminiLocation('fff777');
        await vi.advanceTimersByTimeAsync(CONVERSATION_POLL_INTERVAL);
        expect(chatSyncCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sync attempt records', () => {
    /** A fresh conversation per test — previousManifest is module state. */
    function loadConversation(conversationId: string): void {
      setGeminiLocation(conversationId);
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
    }

    const configured = { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] };

    it('records the trigger and the appended-vs-sent counts of a sync the companion accepted', async () => {
      loadConversation('attempt-record-sent');
      mockMessaging({
        settings: configured,
        chatSync: { ...okChatSync, appended: 2, superseded: 1 },
      });

      await runAutoSync();

      expect(recordSyncAttempt).toHaveBeenCalledWith(location.href, {
        trigger: 'mutation',
        outcome: 'sent',
        sent: 2,
        appended: 2,
        superseded: 1,
      });
    });

    it('records the full failure text when the send fails', async () => {
      loadConversation('attempt-record-error');
      mockMessaging({
        settings: configured,
        chatSync: { success: false, error: 'network blip' },
      });

      await runAutoSync();

      expect(recordSyncAttempt).toHaveBeenCalledWith(location.href, {
        trigger: 'mutation',
        outcome: 'error',
        sent: 2,
        detail: 'network blip',
      });
    });

    it('records why nothing was attempted when the companion is not configured', async () => {
      loadConversation('attempt-record-unconfigured');
      mockMessaging({ settings: { isCompanionConfigured: false } });

      await runAutoSync();

      expect(recordSyncAttempt).toHaveBeenCalledWith(location.href, {
        trigger: 'mutation',
        outcome: 'blocked',
        detail: 'syncIcon_notConfigured',
      });
    });

    it('records a quiet tick as a no-op rather than another send', async () => {
      loadConversation('attempt-record-noop');
      mockMessaging({ settings: configured });
      await runAutoSync();
      vi.mocked(recordSyncAttempt).mockClear();

      await runAutoSync(); // same DOM, nothing new to send

      expect(recordSyncAttempt).toHaveBeenCalledWith(location.href, {
        trigger: 'mutation',
        outcome: 'noop',
      });
    });

    it("records 'manual' for a sync the menu started, not 'mutation'", async () => {
      loadConversation('attempt-record-manual');
      mockMessaging({ settings: configured });
      await initialize();
      const handlers = vi.mocked(injectSyncIcon).mock.calls[0][0];

      handlers.onRetry();

      await vi.waitFor(() =>
        expect(recordSyncAttempt).toHaveBeenCalledWith(
          location.href,
          expect.objectContaining({ trigger: 'manual', outcome: 'sent' })
        )
      );
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

    it('advances the baseline after a full-content resend, so the next sync sends nothing', async () => {
      // A conversation the companion listener already holds from the BACKFILL
      // producer answers the first live sync with `needsFullContent` — its
      // stored hashes cannot be compared against this manifest. The resend is
      // therefore the send that establishes the baseline, and only the
      // resend's response advances `previousManifest`. If it did not, every
      // later run would diff against an empty baseline and resend the whole
      // conversation, forever, behind a green icon.
      setGeminiLocation('needs-full-content-baseline');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );

      const sent: ChatSyncRequest[] = [];
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
          sent.push((message as { data: ChatSyncRequest }).data);
          return Promise.resolve(
            sent.length === 1 ? { ...okChatSync, mode: 'needsFullContent' as const } : okChatSync
          );
        }
        return Promise.reject(new Error('unexpected action'));
      });

      await runAutoSync(); // sends, is told to resend in full, resends
      await runAutoSync(); // same DOM: there is nothing left to send

      expect(sent).toHaveLength(2); // exactly one resend, and no third send
      // The resend is the same conversation, not a re-scoped one: the manifest
      // it declares must still be the whole manifest it was asked about.
      expect(sent[1].manifest).toEqual(sent[0].manifest);
      expect(sent[1].newBlocks.map(b => b.role)).toEqual(['user', 'assistant']);
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
          // settleIcon passes the retained blocked reason too, so a quiet tick
          // can't demote an unresolved local blockage to `synced` (#465/#468).
          blocked: null,
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
      // hitting any bail-out there (e.g. B has no messages yet, which
      // settles via settleBlocked — see below) would settle the icon
      // offline with A's error against a conversation that was never
      // attempted.
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
        await runAutoSync(); // B has no messages: extract() fails, settleBlocked(true) bail-out
        expect(setIconContext).toHaveBeenCalledWith(hrefB);
        expect(setIconContext).toHaveBeenCalledTimes(1);

        // setIconContext is mocked, so mirror its real effect (clearing
        // the retained error) here, same stand-in as above.
        vi.mocked(getLastError).mockReturnValue(null);

        vi.mocked(paintFor).mockClear();
        vi.mocked(deriveState).mockClear();
        await runAutoSync(); // same empty DOM, same href: same blocked bail-out again

        // No messages extracted is itself surfaced as a fresh `blocked`
        // reason every tick (see settleBlocked) — it is never routine, so
        // this must NOT fall back to a bare configured/error/suggestionCount
        // call the way the old settleIcon(true) bail-out used to.
        expect(deriveState).toHaveBeenLastCalledWith({
          configured: true,
          syncing: false,
          error: null,
          suggestionCount: 0,
          blocked: 'No messages found in conversation',
        });
        expect(paintFor).toHaveBeenLastCalledWith(hrefB, 'attention', {
          blocked: 'No messages found in conversation',
        });
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
      // decideManifestSend() can't fire — the client sends a (possibly
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

    it('refuses to send, and does not advance the baseline, when the manifest shrinks to a matching prefix (virtualized tail truncation)', async () => {
      // Regression pin for the row-11 audit finding: a manifest that shrinks
      // to a strict, matching PREFIX of previousManifest (tail messages
      // virtualized out of the DOM) passes the unchanged-check (different
      // length) and the head-shift window guard (index 0 still matches), so
      // diffBlocks() would compute an EMPTY delta. The old code sent that
      // empty delta anyway; the server no-op'd it, and the client — reading
      // nothing wrong with an empty-delta noop — advanced previousManifest
      // to the truncated manifest anyway, poisoning every later diff. The
      // fix refuses to send at all once the shrink is detected, so this
      // must never reach chatSync, never advance the baseline, and must not
      // silently paint `synced` — a client-side detected stall is exactly
      // as actionable as the server-side one covered by the sibling test
      // above, so it paints `attention`, not `offline` (nothing was actually
      // sent to fail) and not `synced` (nothing was actually confirmed).
      setGeminiLocation('auto-sync-tail-truncation');
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
      vi.mocked(paintFor).mockClear();

      await runAutoSync();

      expect(chatSyncCallsOf()).toHaveLength(1); // still just the first, baseline-establishing call
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'attention', {
        blocked: expect.any(String),
      });

      // The baseline must still be the original 4-message manifest, not the
      // truncated 2-message one — proven by sending the original 4 messages
      // again: a poisoned (2-message) baseline would diff this as unchanged
      // or as only a 2-message tail, not the identical no-op it actually is.
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
          { role: 'user', content: 'Second question' },
          { role: 'assistant', content: '<p>Second answer</p>' },
        ])
      );
      vi.mocked(paintFor).mockClear();

      await runAutoSync();

      expect(chatSyncCallsOf()).toHaveLength(1); // unchanged: correctly recognized as the same 4 messages
      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'synced');
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
          blocked: null,
        });
      } finally {
        vi.mocked(suggestionCount).mockReturnValue(0);
      }
    });

    it('arms the watermark watcher with the ordinal the extraction covered (issue #465)', async () => {
      // ChatGPT numbers turns conversation-wide (`conversation-turn-N`), so its
      // extraction reports a watermark where Gemini's reports none.
      setChatGPTLocation('11111111-2222-3333-4444-555555555555');
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['chatgpt'] },
      });

      await runAutoSync();

      // 2 is the second turn's ordinal, carried out of the extraction — never
      // re-read from the DOM afterwards, since a scroll pass ends pinned at the
      // TOP of the conversation where the newest turn is unmounted (#465).
      expect(attachWatermarkWatcher).toHaveBeenCalledWith(location.href, 2, expect.any(Function));
    });

    it('keeps the icon on attention through a quiet tick while the blockage is unresolved', async () => {
      // The #465/#468 hole: startNewMessageWatcher fires at most once and only
      // a confirmed send re-arms it, so if the next quiet tick could derive
      // `synced` the invalidation would be gone for good and a conversation
      // that grew past its sync would look completely synced again. settleIcon
      // is the one bail-out sibling that CAN claim `synced`, which is why it
      // has to pass the retained reason through.
      setGeminiLocation('auto-sync-retained-blockage');
      loadFixture(
        createGeminiConversationDOM([
          { role: 'user', content: 'Hello Gemini' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['gemini'] },
      });
      // Establishes previousManifest for this DOM, so the next run below takes
      // the unchanged-manifest early return into settleIcon.
      await runAutoSync();
      vi.mocked(paintFor).mockClear();
      vi.mocked(getLastBlockedReason).mockReturnValue('syncIcon_conversationGrewSinceSync');

      try {
        await runAutoSync(); // same DOM: the unchanged-manifest early return

        expect(paintFor).toHaveBeenLastCalledWith(location.href, 'attention');
      } finally {
        vi.mocked(getLastBlockedReason).mockReturnValue(null);
      }
    });

    it('stops the previous watermark watcher rather than stacking a second one', async () => {
      setChatGPTLocation('33333333-4444-5555-6666-777777777777');
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['chatgpt'] },
      });
      await runAutoSync();
      const stopFirst = vi.mocked(attachWatermarkWatcher).mock.results[0].value;

      // The same conversation grows, so this tick really sends and arms again.
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
          { role: 'user', content: 'Second question' },
          { role: 'assistant', content: '<p>Second answer</p>' },
        ])
      );
      await runAutoSync();

      // Two armed, one stopped: a second poller for the same signal would poll
      // twice, paint twice, and keep a staler baseline alive than this one.
      expect(attachWatermarkWatcher).toHaveBeenCalledTimes(2);
      expect(stopFirst).toHaveBeenCalledTimes(1);
    });

    it('disarms the watermark watcher when the SPA navigates to another conversation', async () => {
      setChatGPTLocation('44444444-5555-6666-7777-888888888888');
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['chatgpt'] },
      });
      await runAutoSync();
      const stopFirst = vi.mocked(attachWatermarkWatcher).mock.results[0].value;

      // Navigating to a platform the user excluded from auto-sync isolates the
      // disarm: establishAutoSyncContext runs ahead of every bail-out, so the
      // watcher is stopped and nothing re-arms in the same tick.
      setGeminiLocation('watermark-after-navigation');
      loadFixture(
        createGeminiConversationDOM([{ role: 'user', content: 'A different conversation' }])
      );
      await runAutoSync();

      expect(stopFirst).toHaveBeenCalledTimes(1);
      expect(attachWatermarkWatcher).toHaveBeenCalledTimes(1);
    });

    it('disarms the watermark watcher in stopAutoSync, so its poll cannot outlive the page', async () => {
      setChatGPTLocation('55555555-6666-7777-8888-999999999999');
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['chatgpt'] },
      });
      await runAutoSync();
      const stopFirst = vi.mocked(attachWatermarkWatcher).mock.results[0].value;

      stopAutoSync();

      expect(stopFirst).toHaveBeenCalledTimes(1);
    });

    it('arms nothing when the send failed, since there is no synced claim to invalidate', async () => {
      setChatGPTLocation('22222222-3333-4444-5555-666666666666');
      loadFixture(
        createChatGPTConversationDOM([
          { role: 'user', content: 'Hello ChatGPT' },
          { role: 'assistant', content: '<p>Hi there!</p>' },
        ])
      );
      mockMessaging({
        settings: { isCompanionConfigured: true, autoSyncPlatforms: ['chatgpt'] },
        chatSync: { error: 'Companion unreachable' },
      });

      await runAutoSync();

      expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
        error: 'Companion unreachable',
      });
      expect(attachWatermarkWatcher).not.toHaveBeenCalled();
    });

    describe('auto-repair of a virtualized window', () => {
      const settings = { isCompanionConfigured: true, autoSyncPlatforms: ['claude', 'gemini'] };
      const okBackfill: ChatBackfillResponse = {
        notePath: 'AI/claude/full.md',
        anchorsPreserved: 0,
        anchorsIssued: 4,
        superseded: 0,
        skipped: null,
      };

      /** Claude thread whose mounted rows start at `first` (Claude's data-index is conversation-wide). */
      function loadClaudeWindow(id: string, first: number, texts: string[]): void {
        setClaudeLocation(id);
        const rows = texts.map((text, i) => {
          const role = (first + i) % 2 === 0 ? 'user' : 'assistant';
          const inner = createClaudeConversationDOM([{ role, content: text }]);
          return `<div data-index="${first + i}">${inner}</div>`;
        });
        loadFixture(`<div>${rows.join('')}</div>`);
      }

      function backfillFor(id: string): ChatBackfillRequest {
        return {
          conversationId: id,
          platform: 'claude',
          title: 'Full',
          url: `https://claude.ai/chat/${id}`,
          createdAt: '2026-01-01T00:00:00Z',
          accountId: 'org-1',
          accountName: 'Personal',
          messages: [{ role: 'user', markdown: 'q', hash: 'h1', sourceId: 'm1' }],
        };
      }

      function backfillCallsOf(): unknown[] {
        return vi
          .mocked(sendMessage)
          .mock.calls.filter(([m]) => (m as { action: string }).action === 'chatBackfill');
      }

      it('repairs instead of sending when the first sync sees a window that starts above turn 0', async () => {
        const id = '11111111-aaaa-4bbb-8ccc-000000000001';
        loadClaudeWindow(id, 5, ['tail five', 'tail six']);
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillFor(id));
        mockMessaging({ settings, chatBackfill: okBackfill });

        await runAutoSync();

        expect(fetchConversationForRepair).toHaveBeenCalledWith(id);
        expect(backfillCallsOf()).toHaveLength(1);
        expect(chatSyncCallsOf()).toHaveLength(0);

        // The window was adopted as the baseline: the next quiet tick is a no-op.
        await runAutoSync();
        expect(chatSyncCallsOf()).toHaveLength(0);
        expect(backfillCallsOf()).toHaveLength(1);
      });

      it('syncs normally on the first sync when the window starts at turn 0', async () => {
        const id = '11111111-aaaa-4bbb-8ccc-000000000002';
        loadClaudeWindow(id, 0, ['first', 'second']);
        mockMessaging({ settings });

        await runAutoSync();

        expect(fetchConversationForRepair).not.toHaveBeenCalled();
        expect(chatSyncCallsOf()).toHaveLength(1);
      });

      it('repairs when earlier turns appear (head shift), then absorbs further shifts without stalling', async () => {
        const id = '11111111-aaaa-4bbb-8ccc-000000000003';
        loadClaudeWindow(id, 0, ['first', 'second']);
        mockMessaging({ settings, chatBackfill: okBackfill });
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillFor(id));
        await runAutoSync();
        expect(chatSyncCallsOf()).toHaveLength(1);

        // Same conversation; a different, earlier-starting window mounts.
        loadClaudeWindow(id, 0, ['zeroth', 'first', 'second']);
        await runAutoSync();
        expect(backfillCallsOf()).toHaveLength(1);
        expect(chatSyncCallsOf()).toHaveLength(1);

        // Repaired: a further head shift is absorbed, not painted as stalled.
        vi.mocked(paintFor).mockClear();
        loadClaudeWindow(id, 0, ['minus one', 'zeroth', 'first']);
        await runAutoSync();
        expect(backfillCallsOf()).toHaveLength(1);
        expect(chatSyncCallsOf()).toHaveLength(1);
        expect(paintFor).not.toHaveBeenCalledWith(location.href, 'attention', expect.anything());
      });

      it('attempts at most once per conversation: a failed repair falls back to the blocked state', async () => {
        const id = '11111111-aaaa-4bbb-8ccc-000000000004';
        loadClaudeWindow(id, 0, ['first', 'second']);
        mockMessaging({ settings, chatBackfill: { error: 'boom' } });
        vi.mocked(fetchConversationForRepair).mockResolvedValue(backfillFor(id));
        await runAutoSync();

        loadClaudeWindow(id, 0, ['zeroth', 'first', 'second']);
        await runAutoSync(); // repair attempted, fails
        expect(backfillCallsOf()).toHaveLength(1);

        vi.mocked(paintFor).mockClear();
        loadClaudeWindow(id, 0, ['minus one', 'zeroth', 'first', 'second']);
        await runAutoSync(); // guard spent: today's behaviour
        expect(backfillCallsOf()).toHaveLength(1);
        expect(paintFor).toHaveBeenLastCalledWith(location.href, 'attention', {
          blocked: expect.any(String),
        });
      });

      it('leaves tail truncation on the blocked path without repairing', async () => {
        const id = '11111111-aaaa-4bbb-8ccc-000000000005';
        loadClaudeWindow(id, 0, ['first', 'second', 'third']);
        mockMessaging({ settings, chatBackfill: okBackfill });
        await runAutoSync();

        loadClaudeWindow(id, 0, ['first', 'second']);
        vi.mocked(paintFor).mockClear();
        await runAutoSync();

        expect(fetchConversationForRepair).not.toHaveBeenCalled();
        expect(paintFor).toHaveBeenLastCalledWith(location.href, 'attention', {
          blocked: expect.any(String),
        });
      });

      it('never repairs on a platform without an archive adapter (Gemini head shift)', async () => {
        setGeminiLocation('auto-repair-unsupported');
        loadFixture(
          createGeminiConversationDOM([
            { role: 'user', content: 'Original first message' },
            { role: 'assistant', content: '<p>reply</p>' },
          ])
        );
        mockMessaging({ settings });
        await runAutoSync();
        loadFixture(
          createGeminiConversationDOM([
            { role: 'user', content: 'A completely different first message' },
            { role: 'assistant', content: '<p>reply</p>' },
          ])
        );

        await runAutoSync();

        expect(fetchConversationForRepair).not.toHaveBeenCalled();
        expect(chatSyncCallsOf()).toHaveLength(1);
      });
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
        blocked: null,
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

    it('surfaces a save warning after the success toast (issue #376)', async () => {
      vi.useFakeTimers();
      try {
        loadGeminiConversation();
        mockMessaging({
          save: {
            results: [
              {
                destination: 'obsidian',
                success: true,
                warning: '1 image could not be saved: img-note-img-1.png',
              },
            ],
            allSuccessful: true,
            anySuccessful: true,
          },
        });

        const pending = handleSync();
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;

        expect(showSuccessToast).toHaveBeenCalled();
        expect(showWarningToast).toHaveBeenCalledWith(
          '1 image could not be saved: img-note-img-1.png'
        );
      } finally {
        vi.useRealTimers();
      }
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

describe('save response validation (issue #467)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopAutoSync();
    clearFixture();
    resetLocation();
  });

  /** What the background actually sends when it rejects a message (service-worker.ts). */
  const rejection = { success: false, error: 'Invalid message content' };

  it('reports the rejection instead of crashing on the missing results array', async () => {
    // A 1,077-message note tripped the body-size check in the background, which
    // answered {success:false,error}. That envelope used to be handed to the
    // toast code as a save result: "Cannot read properties of undefined
    // (reading 'map')" — the exact text in the report.
    mockMessaging({ save: rejection as unknown as MultiOutputResponse });
    loadGeminiConversation();

    await handleSync();

    expect(showErrorToast).toHaveBeenCalledWith('Invalid message content');
    expect(vi.mocked(showErrorToast).mock.calls[0][0]).not.toContain('reading');
    // Upstream asserted this on showSyncBadge; the sync icon is this fork's
    // equivalent surface, so the rejection must reach it the same way.
    expect(paintFor).toHaveBeenLastCalledWith(location.href, 'offline', {
      error: 'Invalid message content',
    });
  });

  it('names the problem when the response is not a save result at all', async () => {
    mockMessaging({ save: {} as MultiOutputResponse });
    loadGeminiConversation();

    await handleSync();

    const [message] = vi.mocked(showErrorToast).mock.calls[0];
    expect(message).toMatch(/unexpected response/i);
    expect(message).not.toContain('reading');
  });

  it('leaves the icon settled, not stuck syncing, after a rejected save', async () => {
    // Upstream's setButtonLoading(false) assertion: a rejected save must still
    // settle the affordance. Here the icon is the affordance, so "settled"
    // means its last paint is the outcome, never the 'syncing' placeholder.
    mockMessaging({ save: rejection as unknown as MultiOutputResponse });
    loadGeminiConversation();

    await handleSync();

    const lastCall = vi.mocked(paintFor).mock.lastCall!;
    expect(lastCall[1]).not.toBe('syncing');
    expect(lastCall[1]).toBe('offline');
  });
});
