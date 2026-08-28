import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postSync,
  postBackfill,
  flushQueue,
  enqueue,
  dropQueued,
  openNote,
  isCompanionApiError,
} from '../../src/lib/companion-client';
import type { ChatBackfillRequest, ChatSyncRequest } from '../../src/lib/types';

const settings = { companionUrl: 'http://127.0.0.1:3447', companionToken: 'tok' };

const request: ChatSyncRequest = {
  conversationId: 'abc',
  platform: 'claude',
  title: 'T',
  url: 'https://claude.ai/chat/abc',
  manifest: ['h1'],
  newBlocks: [{ role: 'user', markdown: 'hi', hash: 'h1' }],
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

describe('dropQueued', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prevents flushQueue from replaying a stale entry after a newer sync for the same conversation succeeds', async () => {
    // Sync A for conversation X fails and is queued with a stale manifest.
    const staleRequest: ChatSyncRequest = { ...request, manifest: ['h1', 'h2'] };
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    await enqueue(staleRequest);
    expect(stored.companionQueue).toEqual([staleRequest]);

    // Sync B for the same conversation succeeds directly via postSync with a
    // newer manifest (as service-worker.ts's chatSync handler does).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        notePath: 'n.md',
        mode: 'append',
        appended: 2,
        superseded: 0,
        suggestions: { transcripts: [], pages: [] },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const newerRequest: ChatSyncRequest = { ...request, manifest: ['h1', 'h2', 'h3', 'h4'] };
    await postSync(settings, newerRequest);

    // The handler purges the stale queue entry for this conversation before
    // flushing — flushQueue must not re-send the older manifest afterwards.
    await dropQueued(newerRequest.conversationId);
    expect(stored.companionQueue).toEqual([]);

    fetchMock.mockClear();
    expect(await flushQueue(settings)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored.companionQueue).toEqual([]);
  });
});

describe('openNote', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts to /api/chat/open with a bearer token and the given path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(openNote(settings, 'AI/claude/hello.md')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3447/api/chat/open',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: JSON.stringify({ path: 'AI/claude/hello.md' }),
      })
    );
  });

  it('throws with the response detail on a non-OK response, mirroring postSync', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid path' })
    );

    await expect(openNote(settings, 'AI/claude/hello.md')).rejects.toThrow(
      /Companion open failed \(400\): invalid path/
    );
  });

  it('throws when the companion token is empty', async () => {
    await expect(openNote({ ...settings, companionToken: '' }, 'a.md')).rejects.toThrow(
      /not configured/i
    );
  });
});

describe('postBackfill', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts to /api/chat/backfill with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        notePath: 'AI/claude/t-abc.md',
        anchorsPreserved: 0,
        anchorsIssued: 1,
        superseded: 0,
        skipped: null,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postBackfill(settings, backfillRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3447/api/chat/backfill',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: JSON.stringify(backfillRequest),
      })
    );
    expect(result.notePath).toBe('AI/claude/t-abc.md');
  });

  it('throws when the companion token is empty', async () => {
    await expect(
      postBackfill({ ...settings, companionToken: '' }, backfillRequest)
    ).rejects.toThrow(/not configured/i);
  });

  it('throws a CompanionApiError carrying the status and a machine-readable code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ code: 'some_server_signal' }),
      })
    );

    try {
      await postBackfill(settings, backfillRequest);
      expect.unreachable('postBackfill should have thrown');
    } catch (error) {
      expect(isCompanionApiError(error)).toBe(true);
      if (isCompanionApiError(error)) {
        expect(error.status).toBe(409);
        expect(error.code).toBe('some_server_signal');
      }
    }
  });

  it('leaves code undefined when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: false,
          status: 409,
          text: async () => 'newBlocks length mismatch',
        })
    );

    try {
      await postBackfill(settings, backfillRequest);
      expect.unreachable('postBackfill should have thrown');
    } catch (error) {
      expect(isCompanionApiError(error)).toBe(true);
      if (isCompanionApiError(error)) {
        expect(error.status).toBe(409);
        expect(error.code).toBeUndefined();
      }
    }
  });

  it("leaves code undefined for a codeless JSON error body (the server's actual newBlocks-mismatch shape)", async () => {
    // The server's real newBlocks-length-mismatch 409 is valid JSON with an
    // `error` field, not `code` — a distinct case from the non-JSON body
    // above. isRetryableCompanionFailure (service-worker.ts) treats "409
    // with no code" as a permanent client bug that must never be retried,
    // so this exact shape is the one the whole distinction was built for.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: 'newBlocks length mismatch' }),
      })
    );

    try {
      await postBackfill(settings, backfillRequest);
      expect.unreachable('postBackfill should have thrown');
    } catch (error) {
      expect(isCompanionApiError(error)).toBe(true);
      if (isCompanionApiError(error)) {
        expect(error.status).toBe(409);
        expect(error.code).toBeUndefined();
      }
    }
  });
});
