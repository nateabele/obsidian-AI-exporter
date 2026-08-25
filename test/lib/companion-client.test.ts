import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postSync, flushQueue } from '../../src/lib/companion-client';
import type { ChatSyncRequest } from '../../src/lib/types';

const settings = { companionUrl: 'http://127.0.0.1:3447', companionToken: 'tok' };

const request: ChatSyncRequest = {
  conversationId: 'abc',
  platform: 'claude',
  title: 'T',
  url: 'https://claude.ai/chat/abc',
  manifest: ['h1'],
  newBlocks: [{ role: 'user', markdown: 'hi', hash: 'h1' }],
};

describe('postSync', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts to /api/chat/sync with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        notePath: 'AI/claude/t-abc.md',
        mode: 'append',
        appended: 1,
        superseded: 0,
        suggestions: { transcripts: [], pages: [] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postSync(settings, request);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3447/api/chat/sync',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      })
    );
    expect(result.mode).toBe('append');
  });

  it('throws a descriptive error on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' })
    );
    await expect(postSync(settings, request)).rejects.toThrow(/401/);
  });

  it('throws when the companion token is empty', async () => {
    await expect(postSync({ ...settings, companionToken: '' }, request)).rejects.toThrow(
      /not configured/i
    );
  });
});

describe('flushQueue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends every queued request and empties the queue', async () => {
    const stored: Record<string, unknown> = {
      companionQueue: [request, { ...request, conversationId: 'def' }],
    };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          notePath: 'n.md',
          mode: 'append',
          appended: 1,
          superseded: 0,
          suggestions: { transcripts: [], pages: [] },
        }),
      })
    );

    expect(await flushQueue(settings)).toBe(2);
    expect(stored.companionQueue).toEqual([]);
  });

  it('retains requests that still fail', async () => {
    const stored: Record<string, unknown> = { companionQueue: [request] };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    expect(await flushQueue(settings)).toBe(0);
    expect(stored.companionQueue).toHaveLength(1);
  });
});
