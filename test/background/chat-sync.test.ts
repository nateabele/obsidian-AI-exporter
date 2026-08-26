/**
 * Background service worker: chatSync wiring
 *
 * There is otherwise no coverage exercising service-worker.ts's `chatSync`
 * case directly. A regression that reordered or dropped the dropQueued()
 * call would go unnoticed — that call is what stops a stale queued manifest
 * from corrupting a user's transcript after a newer sync already succeeded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatSyncRequest, ChatSyncResponse } from '../../src/lib/types';

const mockCompanion = {
  postSync: vi.fn(),
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

const sender = { tab: { url: 'https://claude.ai/chat/abc' } } as chrome.runtime.MessageSender;

describe('background/service-worker chatSync wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCompanion.postSync.mockReset();
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
});
