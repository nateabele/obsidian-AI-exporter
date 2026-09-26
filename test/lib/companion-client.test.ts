import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  postSync,
  postBackfill,
  flushQueue,
  enqueue,
  dropQueued,
  openNote,
  isCompanionApiError,
  recordFlushResult,
  getQueueStatus,
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

  it('logs, rather than silently yielding an empty detail, when the error body itself fails to read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error('stream already consumed');
        },
      })
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(postSync(settings, request)).rejects.toThrow(/500/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read the response body for a failed companion sync request'
      ),
      expect.any(Error)
    );
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
      companionQueue: [
        { request, attempts: 0 },
        { request: { ...request, conversationId: 'def' }, attempts: 0 },
      ],
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

    expect(await flushQueue(settings)).toEqual({
      sent: 2,
      refused: 0,
      failed: 0,
      exhausted: 0,
      remaining: 0,
    });
    expect(stored.companionQueue).toEqual([]);
  });

  it('retains a request that fails, incrementing its attempt count, and logs it rather than swallowing it', async () => {
    const stored: Record<string, unknown> = { companionQueue: [{ request, attempts: 0 }] };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await flushQueue(settings)).toEqual({
      sent: 0,
      refused: 0,
      failed: 1,
      exhausted: 0,
      remaining: 1,
    });
    expect(stored.companionQueue).toEqual([{ request, attempts: 1 }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Queued sync for conversation ${request.conversationId}`),
      expect.any(Error)
    );
  });

  it('does not count a server refusal (noop for a non-empty delta) as sent, and keeps it queued', async () => {
    const stored: Record<string, unknown> = { companionQueue: [{ request, attempts: 0 }] };
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
          mode: 'noop',
          appended: 0,
          superseded: 0,
          suggestions: { transcripts: [], pages: [] },
        }),
      })
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await flushQueue(settings)).toEqual({
      sent: 0,
      refused: 1,
      failed: 0,
      exhausted: 0,
      remaining: 1,
    });
    expect(stored.companionQueue).toEqual([{ request, attempts: 1 }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('was refused by the companion'),
      expect.anything()
    );
  });

  it('drops an entry and reports it exhausted after enough failed replay attempts, instead of retrying forever', async () => {
    const stored: Record<string, unknown> = {
      companionQueue: [{ request, attempts: 4 }], // one more failure hits MAX_REPLAY_ATTEMPTS (5)
    };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await flushQueue(settings)).toEqual({
      sent: 0,
      refused: 0,
      failed: 1,
      exhausted: 1,
      remaining: 0,
    });
    expect(stored.companionQueue).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Giving up on queued sync for conversation ${request.conversationId}`
      ),
      expect.any(Error)
    );
  });
});

describe('recordFlushResult / getQueueStatus', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('round-trips the last flush result and current queue depth', async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.map(k => [k, stored[k]]));
          },
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });

    expect(await getQueueStatus()).toEqual({ queued: 0, lastFlush: null });

    await enqueue(request);
    const flushResult = { sent: 0, refused: 1, failed: 0, exhausted: 0, remaining: 1 };
    await recordFlushResult(flushResult);

    expect(await getQueueStatus()).toEqual({ queued: 1, lastFlush: flushResult });
  });
});

describe('enqueue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('logs when it drops a stale queued entry for the same conversation (intentional, not a bug)', async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enqueue(request);
    warnSpy.mockClear();
    const newer = { ...request, manifest: ['h1', 'h2'] };
    await enqueue(newer);

    expect(stored.companionQueue).toEqual([{ request: newer, attempts: 0 }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `Dropping stale queued sync for conversation ${request.conversationId}`
      )
    );
  });

  it('logs and drops the oldest entries when the queue exceeds its cap', async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 51; i++) {
      await enqueue({ ...request, conversationId: `conv-${i}` });
    }

    const queue = stored.companionQueue as { request: ChatSyncRequest }[];
    expect(queue).toHaveLength(50);
    expect(queue[0].request.conversationId).toBe('conv-1'); // conv-0 dropped as oldest
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Companion replay queue exceeded 50 entries')
    );
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
    expect(stored.companionQueue).toEqual([{ request: staleRequest, attempts: 0 }]);

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
    expect(await flushQueue(settings)).toEqual({
      sent: 0,
      refused: 0,
      failed: 0,
      exhausted: 0,
      remaining: 0,
    });
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
      vi.fn().mockResolvedValue({
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

describe('queue format migration (upgrade safety)', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Before the attempt-tracking change the queue stored bare ChatSyncRequest
  // objects; it now stores { request, attempts }. Anyone upgrading with a
  // non-empty queue has old-shape rows in storage, and every reader does
  // `q.request.conversationId` — which throws on them. It fails SILENTLY:
  // enqueue() is called inside a catch in service-worker.ts, so the TypeError
  // is logged and the retry is simply never queued.
  const legacyRequest = {
    conversationId: 'legacy-1',
    platform: 'claude' as const,
    title: 'Legacy',
    url: 'https://claude.ai/chat/legacy-1',
    manifest: ['h1'],
    newBlocks: [{ role: 'user' as const, markdown: 'hi', hash: 'h1' }],
  };

  const stubStorageWith = (initial: unknown[]) => {
    const stored: Record<string, unknown> = { companionQueue: initial };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
        },
      },
    });
    return stored;
  };

  it('enqueue does not throw on a legacy-shape queue', async () => {
    stubStorageWith([legacyRequest]);
    await expect(
      enqueue({ ...legacyRequest, conversationId: 'new-1' })
    ).resolves.not.toThrow();
  });

  it('enqueue normalises a legacy entry and keeps it alongside the new one', async () => {
    const stored = stubStorageWith([legacyRequest]);
    await enqueue({ ...legacyRequest, conversationId: 'new-1' });
    const q = stored.companionQueue as { request: { conversationId: string }; attempts: number }[];
    expect(q).toHaveLength(2);
    expect(q[0].request.conversationId).toBe('legacy-1');
    expect(q[0].attempts).toBe(0);
  });

  it('enqueue still dedupes against a legacy entry for the same conversation', async () => {
    const stored = stubStorageWith([legacyRequest]);
    await enqueue(legacyRequest);
    const q = stored.companionQueue as { request: { conversationId: string } }[];
    expect(q).toHaveLength(1);
    expect(q[0].request.conversationId).toBe('legacy-1');
  });

  it('dropQueued removes a legacy entry by conversation id', async () => {
    const stored = stubStorageWith([legacyRequest]);
    await dropQueued('legacy-1');
    expect(stored.companionQueue as unknown[]).toHaveLength(0);
  });
});
