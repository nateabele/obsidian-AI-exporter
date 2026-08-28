/**
 * Background service worker: chatSync wiring
 *
 * There is otherwise no coverage exercising service-worker.ts's `chatSync`
 * case directly. A regression that reordered or dropped the dropQueued()
 * call would go unnoticed — that call is what stops a stale queued manifest
 * from corrupting a user's transcript after a newer sync already succeeded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatBackfillRequest, ChatSyncRequest, ChatSyncResponse } from '../../src/lib/types';
import { BACKFILL_LOCK_RETRY_DELAY } from '../../src/lib/constants';

const mockCompanion = {
  postSync: vi.fn(),
  postBackfill: vi.fn(),
  enqueue: vi.fn(),
  dropQueued: vi.fn(),
  flushQueue: vi.fn(),
};

const defaultSettings = {
  obsidianApiKey: 'test-api-key',
  obsidianUrl: 'http://127.0.0.1:27123',
  vaultPath: 'AI/Gemini',
  templateOptions: {
    includeId: true,
    includeTitle: true,
    includeTags: true,
    includeSource: true,
    includeDates: true,
    includeMessageCount: true,
    messageFormat: 'callout' as const,
    userCalloutType: 'QUESTION' as const,
    assistantCalloutType: 'NOTE' as const,
  },
  enableImageExport: true,
  imageVaultPath: 'AI/{platform}/images',
  flattenLargeCallouts: true,
  maxCalloutLines: 200,
  companionToken: 'test-companion-token',
  companionUrl: 'http://127.0.0.1:3447',
  autoSyncPlatforms: ['claude', 'chatgpt'],
};

let mockGetSettings = vi.fn(() => Promise.resolve(defaultSettings));

let capturedListener: (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => boolean | undefined;

const request: ChatSyncRequest = {
  conversationId: 'abc',
  platform: 'claude',
  title: 'T',
  url: 'https://claude.ai/chat/abc',
  manifest: ['h1'],
  newBlocks: [{ role: 'user', markdown: 'hi', hash: 'h1' }],
};

const chatSyncResult: ChatSyncResponse = {
  notePath: 'AI/claude/t-abc.md',
  mode: 'append',
  appended: 1,
  superseded: 0,
  suggestions: { transcripts: [], pages: [] },
};

const backfillRequest: ChatBackfillRequest = {
  conversationId: 'abc',
  platform: 'claude',
  title: 'T',
  url: 'https://claude.ai/chat/abc',
  createdAt: '2025-01-01T00:00:00Z',
  accountId: 'org-1',
  accountName: 'Personal',
  messages: [{ role: 'user', markdown: 'hi', hash: 'h1', sourceId: 'm1' }],
};

const sender = { tab: { url: 'https://claude.ai/chat/abc' } } as chrome.runtime.MessageSender;

describe('background/service-worker chatSync wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCompanion.postSync.mockReset();
    mockCompanion.postBackfill.mockReset();
    mockCompanion.enqueue.mockReset();
    mockCompanion.dropQueued.mockReset();
    mockCompanion.flushQueue.mockReset();
    mockGetSettings = vi.fn(() => Promise.resolve(defaultSettings));

    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(listener => {
      capturedListener = listener;
    });

    vi.resetModules();

    vi.doMock('../../src/lib/companion-client', () => mockCompanion);
    vi.doMock('../../src/lib/storage', () => ({
      getSettings: () => mockGetSettings(),
      migrateSettings: vi.fn(() => Promise.resolve()),
    }));

    await import('../../src/background/service-worker');
  });

  it('drops the queue for this conversation and flushes it, after postSync succeeds', async () => {
    const callOrder: string[] = [];
    mockCompanion.postSync.mockImplementation(async () => {
      callOrder.push('postSync');
      return chatSyncResult;
    });
    mockCompanion.dropQueued.mockImplementation(async () => {
      callOrder.push('dropQueued');
    });
    mockCompanion.flushQueue.mockImplementation(async () => {
      callOrder.push('flushQueue');
      return 0;
    });

    const sendResponse = vi.fn();
    capturedListener({ action: 'chatSync', data: request }, sender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mockCompanion.postSync).toHaveBeenCalledWith(
      {
        companionUrl: defaultSettings.companionUrl,
        companionToken: defaultSettings.companionToken,
      },
      request
    );
    expect(mockCompanion.dropQueued).toHaveBeenCalledWith(request.conversationId);
    expect(mockCompanion.flushQueue).toHaveBeenCalledWith({
      companionUrl: defaultSettings.companionUrl,
      companionToken: defaultSettings.companionToken,
    });
    expect(callOrder).toEqual(['postSync', 'dropQueued', 'flushQueue']);
    expect(mockCompanion.enqueue).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(chatSyncResult);
  });

  it('enqueues the request and never drops the queue when postSync fails', async () => {
    mockCompanion.postSync.mockRejectedValue(new Error('network down'));
    mockCompanion.enqueue.mockResolvedValue(undefined);

    const sendResponse = vi.fn();
    capturedListener({ action: 'chatSync', data: request }, sender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mockCompanion.enqueue).toHaveBeenCalledWith(request);
    expect(mockCompanion.dropQueued).not.toHaveBeenCalled();
    expect(mockCompanion.flushQueue).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('network down') })
    );
  });

  describe('newBlocks validation', () => {
    it.each([
      ['missing role', { markdown: 'hi', hash: 'h1' }],
      ['invalid role', { role: 'system', markdown: 'hi', hash: 'h1' }],
      ['missing hash', { role: 'user', markdown: 'hi' }],
      ['empty hash', { role: 'user', markdown: 'hi', hash: '' }],
      ['non-string hash', { role: 'user', markdown: 'hi', hash: 42 }],
      ['non-string markdown', { role: 'user', markdown: 42, hash: 'h1' }],
    ])('rejects a newBlocks entry with %s instead of reaching postSync', async (_label, block) => {
      const sendResponse = vi.fn();
      capturedListener(
        { action: 'chatSync', data: { ...request, newBlocks: [block] } },
        sender,
        sendResponse
      );

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid message content',
      });
      expect(mockCompanion.postSync).not.toHaveBeenCalled();
    });

    it('accepts a well-formed newBlocks entry', async () => {
      mockCompanion.postSync.mockResolvedValue(chatSyncResult);

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatSync', data: request }, sender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(sendResponse).toHaveBeenCalledWith(chatSyncResult);
    });
  });

  describe('409 retry distinction', () => {
    it('enqueues a 409 that carries a code (e.g. conversation_locked)', async () => {
      const lockedError = Object.assign(new Error('locked'), {
        status: 409,
        code: 'conversation_locked',
      });
      mockCompanion.postSync.mockRejectedValue(lockedError);
      mockCompanion.enqueue.mockResolvedValue(undefined);

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatSync', data: request }, sender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(mockCompanion.enqueue).toHaveBeenCalledWith(request);
    });

    it('never enqueues a codeless 409 (permanent client bug, not contention)', async () => {
      const mismatchError = Object.assign(new Error('newBlocks length mismatch'), {
        status: 409,
      });
      mockCompanion.postSync.mockRejectedValue(mismatchError);

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatSync', data: request }, sender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(mockCompanion.enqueue).not.toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('newBlocks length mismatch'),
        })
      );
    });
  });
});

describe('background/service-worker chatBackfill wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCompanion.postSync.mockReset();
    mockCompanion.postBackfill.mockReset();
    mockCompanion.enqueue.mockReset();
    mockCompanion.dropQueued.mockReset();
    mockCompanion.flushQueue.mockReset();
    mockGetSettings = vi.fn(() => Promise.resolve(defaultSettings));

    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(listener => {
      capturedListener = listener;
    });

    vi.resetModules();

    vi.doMock('../../src/lib/companion-client', () => mockCompanion);
    vi.doMock('../../src/lib/storage', () => ({
      getSettings: () => mockGetSettings(),
      migrateSettings: vi.fn(() => Promise.resolve()),
    }));

    await import('../../src/background/service-worker');
  });

  it('posts the backfill request and returns the result directly', async () => {
    const backfillResult = {
      notePath: 'AI/claude/t-abc.md',
      anchorsPreserved: 0,
      anchorsIssued: 1,
      superseded: 0,
      skipped: null,
    };
    mockCompanion.postBackfill.mockResolvedValue(backfillResult);

    const sendResponse = vi.fn();
    capturedListener({ action: 'chatBackfill', data: backfillRequest }, sender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mockCompanion.postBackfill).toHaveBeenCalledWith(
      {
        companionUrl: defaultSettings.companionUrl,
        companionToken: defaultSettings.companionToken,
      },
      backfillRequest
    );
    expect(sendResponse).toHaveBeenCalledWith(backfillResult);
  });

  it('never enqueues a failed backfill — it is a one-off import, not a background retry loop', async () => {
    mockCompanion.postBackfill.mockRejectedValue(new Error('companion offline'));

    const sendResponse = vi.fn();
    capturedListener({ action: 'chatBackfill', data: backfillRequest }, sender, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mockCompanion.enqueue).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('companion offline'),
      })
    );
  });

  // The likeliest lock collision in the design: clicking "Repair this
  // conversation from source" on the conversation being viewed while its
  // own debounced auto-sync is still in flight. The server answers 409
  // conversation_locked; before this retry the extension just showed an
  // error toast and painted `offline`.
  describe('409 lock-contention retry', () => {
    it('retries once after a delay when a 409 carries code conversation_locked', async () => {
      vi.useFakeTimers();
      const backfillResult = {
        notePath: 'AI/claude/t-abc.md',
        anchorsPreserved: 1,
        anchorsIssued: 0,
        superseded: 0,
        skipped: null,
      };
      mockCompanion.postBackfill
        .mockRejectedValueOnce(
          Object.assign(new Error('locked'), { status: 409, code: 'conversation_locked' })
        )
        .mockResolvedValueOnce(backfillResult);

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatBackfill', data: backfillRequest }, sender, sendResponse);

      await vi.waitFor(() => expect(mockCompanion.postBackfill).toHaveBeenCalledTimes(1));
      expect(sendResponse).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(BACKFILL_LOCK_RETRY_DELAY);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(mockCompanion.postBackfill).toHaveBeenCalledTimes(2);
      expect(sendResponse).toHaveBeenCalledWith(backfillResult);
      vi.useRealTimers();
    });

    it('never retries a codeless 409 — that is a permanent client bug, not contention', async () => {
      mockCompanion.postBackfill.mockRejectedValue(
        Object.assign(new Error('newBlocks length mismatch'), { status: 409 })
      );

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatBackfill', data: backfillRequest }, sender, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(mockCompanion.postBackfill).toHaveBeenCalledTimes(1);
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('newBlocks length mismatch'),
        })
      );
    });

    it('surfaces the retry\'s own failure when the lock is still held', async () => {
      vi.useFakeTimers();
      mockCompanion.postBackfill.mockRejectedValue(
        Object.assign(new Error('locked'), { status: 409, code: 'conversation_locked' })
      );

      const sendResponse = vi.fn();
      capturedListener({ action: 'chatBackfill', data: backfillRequest }, sender, sendResponse);

      await vi.waitFor(() => expect(mockCompanion.postBackfill).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(BACKFILL_LOCK_RETRY_DELAY);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(mockCompanion.postBackfill).toHaveBeenCalledTimes(2);
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('locked') })
      );
      vi.useRealTimers();
    });
  });

  describe('validation', () => {
    it.each([
      ['missing conversationId', { ...backfillRequest, conversationId: '' }],
      ['unknown platform', { ...backfillRequest, platform: 'not-a-platform' }],
      [
        'accountId neither a string nor null',
        { ...backfillRequest, accountId: 42 as unknown as string },
      ],
      [
        'a message missing hash',
        { ...backfillRequest, messages: [{ role: 'user', markdown: 'hi', sourceId: 'm1', hash: '' }] },
      ],
    ])('rejects a chatBackfill payload with %s instead of reaching postBackfill', async (_label, data) => {
      const sendResponse = vi.fn();
      capturedListener({ action: 'chatBackfill', data }, sender, sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid message content',
      });
      expect(mockCompanion.postBackfill).not.toHaveBeenCalled();
    });
  });
});
