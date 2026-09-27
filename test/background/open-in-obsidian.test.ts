/**
 * Background service worker: openInObsidian wiring
 *
 * There is otherwise no coverage exercising service-worker.ts's
 * `openInObsidian` case directly — a regression that dropped the companion
 * settings or the path on the way to openNote() would go unnoticed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCompanion = {
  postSync: vi.fn(),
  enqueue: vi.fn(),
  dropQueued: vi.fn(),
  flushQueue: vi.fn(),
  openNote: vi.fn(),
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

const sender = { tab: { url: 'https://claude.ai/chat/abc' } } as chrome.runtime.MessageSender;

describe('background/service-worker openInObsidian wiring', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockCompanion.postSync.mockReset();
    mockCompanion.enqueue.mockReset();
    mockCompanion.dropQueued.mockReset();
    mockCompanion.flushQueue.mockReset();
    mockCompanion.openNote.mockReset();
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

  it('calls openNote with the companion settings and the requested path', async () => {
    mockCompanion.openNote.mockResolvedValue(undefined);

    const sendResponse = vi.fn();
    capturedListener(
      { action: 'openInObsidian', data: { path: 'AI/claude/hello.md' } },
      sender,
      sendResponse
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());

    expect(mockCompanion.openNote).toHaveBeenCalledWith(
      {
        companionUrl: defaultSettings.companionUrl,
        companionToken: defaultSettings.companionToken,
      },
      'AI/claude/hello.md'
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('reports success: false with the detail when openNote rejects (e.g. a non-OK response)', async () => {
    mockCompanion.openNote.mockRejectedValue(new Error('Companion open failed (400): bad path'));

    const sendResponse = vi.fn();
    capturedListener(
      { action: 'openInObsidian', data: { path: 'AI/claude/hello.md' } },
      sender,
      sendResponse
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Companion open failed (400): bad path',
    });
  });

  it('converts a thrown error into a MessageErrorResponse', async () => {
    mockCompanion.openNote.mockRejectedValue(new Error('companion unreachable'));

    const sendResponse = vi.fn();
    capturedListener(
      { action: 'openInObsidian', data: { path: 'AI/claude/hello.md' } },
      sender,
      sendResponse
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('unreachable') })
    );
  });
});
