/**
 * Client for the Mail API companion listener.
 *
 * Only ever called from the background service worker: a content script runs on
 * an https: page and cannot fetch http://127.0.0.1 (mixed content).
 */

import type {
  ChatBackfillRequest,
  ChatBackfillResponse,
  ChatSyncQueueStatus,
  ChatSyncRequest,
  ChatSyncResponse,
  FlushQueueResult,
} from './types';

const QUEUE_KEY = 'companionQueue';
// Last completed flushQueue() cycle, so a caller that didn't itself trigger
// the flush (e.g. a future message handler answering the sync icon) can
// still learn what happened. Written by recordFlushResult(), which callers
// of flushQueue() are expected to call with its result (see
// service-worker.ts).
const QUEUE_STATS_KEY = 'companionQueueStats';
const MAX_QUEUED = 50;

/**
 * How many replay cycles flushQueue() will attempt for a single queued
 * request — whether it fails outright (network error, non-OK status, etc.)
 * or is refused (a `noop` response to a non-empty delta, see flushQueue)
 * — before giving up on it. Without a ceiling, a request the companion will
 * never accept (permanently offline, or a manifest the server keeps
 * rejecting) would sit in the queue and be retried forever with nothing to
 * show for it. Once an entry's attempts reach this count, it is dropped and
 * counted in `FlushQueueResult.exhausted` instead — logged loudly, not
 * swallowed.
 */
const MAX_REPLAY_ATTEMPTS = 5;

/**
 * A request sitting in the replay queue, paired with how many replay
 * cycles have already failed or been refused for it. See
 * `MAX_REPLAY_ATTEMPTS`. Client-side bookkeeping only: `request` is the
 * exact `ChatSyncRequest` that goes over the wire, unchanged.
 */
interface QueuedRequest {
  request: ChatSyncRequest;
  attempts: number;
}

export interface CompanionSettings {
  companionUrl: string;
  companionToken: string;
}

/**
 * A non-OK response from the companion listener. Carries the server's
 * machine-readable `code` when the response body included one, so a caller
 * can tell apart two failures that share the same HTTP status but need
 * opposite retry handling. That distinction is load-bearing for exactly one
 * rule today: a 409 with NO code is chatSyncService's newBlocks-length
 * mismatch, a permanent client-side bug that must never be replayed, while
 * a coded 409 is a deliberate server signal that may be. Reading `code` off
 * the body is the only way to tell those apart — the status alone cannot.
 */
export class CompanionApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'CompanionApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Type guard for {@link CompanionApiError}.
 */
export function isCompanionApiError(error: unknown): error is CompanionApiError {
  return error instanceof CompanionApiError;
}

/**
 * Build the error to throw for a non-OK companion response, extracting the
 * server's `code` field when the body is JSON and has one. A non-JSON body
 * (or one with no `code`) simply leaves `code` unset — this must never
 * throw itself, since detail is only ever used for a human-readable
 * message.
 */
async function companionError(action: string, response: Response): Promise<CompanionApiError> {
  let detail = '';
  try {
    detail = await response.text();
  } catch (error) {
    // Logged rather than swallowed: an empty `detail` from here reads
    // identically to a companion that genuinely sent no body, so without
    // this a body-read failure would silently masquerade as that instead.
    console.warn(
      `[G2O] Failed to read the response body for a failed companion ${action} request (status ${response.status}); proceeding with an empty error detail`,
      error
    );
  }
  let code: string | undefined;
  try {
    const parsed = JSON.parse(detail) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    /* body wasn't JSON — no machine-readable code available */
  }
  return new CompanionApiError(
    response.status,
    `Companion ${action} failed (${response.status}): ${detail}`,
    code
  );
}

export async function postSync(
  settings: CompanionSettings,
  request: ChatSyncRequest
): Promise<ChatSyncResponse> {
  if (!settings.companionToken) {
    throw new Error('Companion token is not configured');
  }
  const response = await fetch(`${settings.companionUrl}/api/chat/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.companionToken}`,
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await companionError('sync', response);
  }
  return (await response.json()) as ChatSyncResponse;
}

/**
 * Post a whole conversation, fetched directly from a platform's own API
 * (see `src/content/archive/`), to the companion listener's authoritative
 * import endpoint. Mirrors `postSync` exactly; the only difference is the
 * endpoint and payload shape, since the server treats this as a distinct,
 * non-incremental write path.
 */
export async function postBackfill(
  settings: CompanionSettings,
  request: ChatBackfillRequest
): Promise<ChatBackfillResponse> {
  if (!settings.companionToken) {
    throw new Error('Companion token is not configured');
  }
  const response = await fetch(`${settings.companionUrl}/api/chat/backfill`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.companionToken}`,
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await companionError('backfill', response);
  }
  return (await response.json()) as ChatBackfillResponse;
}

/**
 * Ask the companion listener to open a note in Obsidian.
 *
 * The companion validates and canonicalises `path` server-side, so this is
 * a thin pass-through: no client-side path handling belongs here. Throws
 * (rather than resolving `false`) on a non-OK response, mirroring
 * `postSync` — this lets callers rely on the message listener's single
 * catch-and-report path (see `service-worker.ts`) instead of duplicating
 * failure handling here.
 */
export async function openNote(settings: CompanionSettings, path: string): Promise<void> {
  if (!settings.companionToken) {
    throw new Error('Companion token is not configured');
  }
  const response = await fetch(`${settings.companionUrl}/api/chat/open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.companionToken}`,
    },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw await companionError('open', response);
  }
}

/**
 * Normalise a raw stored queue, tolerating entries written by an older version.
 *
 * Before the attempt-tracking change the queue held bare `ChatSyncRequest`
 * objects; it now holds `{ request, attempts }`. Anyone who upgrades with a
 * non-empty queue therefore has old-shape rows in storage, and every reader
 * here dereferences `q.request.conversationId` — which throws on them.
 *
 * The throw would not be visible: `enqueue()` is called from inside a catch in
 * service-worker.ts, so a TypeError here is logged and the retry is simply
 * never queued — a failure that leaves no trace, which is the exact defect
 * class this file's other fixes were about. Normalise on read instead, and let
 * the next write persist the new shape.
 */
function normalizeQueue(raw: unknown): QueuedRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): QueuedRequest[] => {
    if (entry && typeof entry === 'object' && 'request' in entry) {
      return [entry as QueuedRequest];
    }
    // Legacy row: a bare ChatSyncRequest. Start it at zero attempts — it has
    // never been counted, and crediting it with prior failures it may not have
    // had would retire it early.
    if (entry && typeof entry === 'object' && 'conversationId' in entry) {
      return [{ request: entry as ChatSyncRequest, attempts: 0 }];
    }
    return [];
  });
}

async function readQueue(): Promise<QueuedRequest[]> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return normalizeQueue(stored[QUEUE_KEY]);
}

export async function enqueue(request: ChatSyncRequest): Promise<void> {
  const queue = await readQueue();
  const stale = queue.find(q => q.request.conversationId === request.conversationId);
  if (stale) {
    // Intentional and correct, not a bug: the newer delta is a superset of
    // the stale one, since the baseline is never advanced on a failed sync
    // (see handleChatSync in service-worker.ts), so replaying the older
    // manifest afterwards would add nothing. Logged so this is visible
    // rather than a silent drop the next person debugging a "missing"
    // retry has to rediscover from scratch.
    console.warn(
      `[G2O] Dropping stale queued sync for conversation ${stale.request.conversationId} — superseded by a newer failed attempt`
    );
  }
  const withoutStale = queue.filter(q => q.request.conversationId !== request.conversationId);
  withoutStale.push({ request, attempts: 0 });

  const overflow = withoutStale.length - MAX_QUEUED;
  if (overflow > 0) {
    const dropped = withoutStale.slice(0, overflow);
    console.warn(
      `[G2O] Companion replay queue exceeded ${MAX_QUEUED} entries — dropping ${overflow} oldest ` +
        `queued sync(s) for conversation(s): ${dropped.map(q => q.request.conversationId).join(', ')}`
    );
  }

  await chrome.storage.local.set({ [QUEUE_KEY]: withoutStale.slice(-MAX_QUEUED) });
}

/**
 * Remove any queued request for a conversation.
 *
 * A queued failure can go stale the moment a *later* sync for the same
 * conversation succeeds via the direct postSync() path: flushQueue() would
 * otherwise still replay the older manifest afterwards, which the companion
 * server would classify as a divergence and demote the newer, already-synced
 * blocks to superseded. Call this right after a successful postSync() for a
 * conversation, before flushQueue() runs.
 */
export async function dropQueued(conversationId: string): Promise<void> {
  const queue = await readQueue();
  const withoutStale = queue.filter(q => q.request.conversationId !== conversationId);
  if (withoutStale.length !== queue.length) {
    await chrome.storage.local.set({ [QUEUE_KEY]: withoutStale });
  }
}

/**
 * Bookkeeping shared by both ways a replay can fail to land this cycle:
 * refused by the server, or an outright error. Either counts toward the
 * entry's `attempts`; once that reaches `MAX_REPLAY_ATTEMPTS` the entry is
 * dropped for good (and that's logged loudly, via console.error, since
 * nothing else will ever surface it again) rather than requeued (a warning,
 * so a human watching the console can tell which conversation and why).
 */
function requeueOrDrop(
  entry: QueuedRequest,
  reason: 'refused' | 'failed',
  remaining: QueuedRequest[],
  result: FlushQueueResult,
  error?: unknown
): void {
  const conversationId = entry.request.conversationId;
  const attempts = entry.attempts + 1;
  if (reason === 'refused') {
    result.refused += 1;
  } else {
    result.failed += 1;
  }

  if (attempts >= MAX_REPLAY_ATTEMPTS) {
    result.exhausted += 1;
    const detail =
      reason === 'refused' ? 'the companion refused every replay' : 'every replay attempt failed';
    console.error(
      `[G2O] Giving up on queued sync for conversation ${conversationId} after ${attempts} attempts (${detail}) — dropping it from the replay queue`,
      error ?? ''
    );
    return;
  }

  const verb = reason === 'refused' ? 'was refused by the companion' : 'failed to replay';
  console.warn(
    `[G2O] Queued sync for conversation ${conversationId} ${verb} (attempt ${attempts}/${MAX_REPLAY_ATTEMPTS}); will retry next cycle`,
    error ?? ''
  );
  remaining.push({ request: entry.request, attempts });
}

export async function flushQueue(settings: CompanionSettings): Promise<FlushQueueResult> {
  const queue = await readQueue();
  const result: FlushQueueResult = { sent: 0, refused: 0, failed: 0, exhausted: 0, remaining: 0 };
  const remaining: QueuedRequest[] = [];

  for (const entry of queue) {
    const { request } = entry;
    try {
      const response = await postSync(settings, request);
      // Mirror `sendChatSync` in src/content/bootstrap.ts: a `noop`
      // response to a non-empty delta means the companion REFUSED the
      // manifest (e.g. its Guard 2 rejecting a suspected virtualised
      // window), not that nothing changed — postSync resolves for any 2xx,
      // including this one. Counting it as sent would permanently discard
      // a manifest the server never actually stored, with no record left
      // behind.
      if (request.newBlocks.length > 0 && response.mode === 'noop') {
        requeueOrDrop(entry, 'refused', remaining, result);
        continue;
      }
      result.sent += 1;
    } catch (error) {
      requeueOrDrop(entry, 'failed', remaining, result, error);
    }
  }

  result.remaining = remaining.length;
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  return result;
}

/**
 * Persist the outcome of the most recent flushQueue() cycle, so a caller
 * that didn't itself trigger the flush can still learn what happened. Call
 * this with whatever flushQueue() just returned — see service-worker.ts,
 * which is the only place flushQueue() is ever invoked from.
 */
export async function recordFlushResult(result: FlushQueueResult): Promise<void> {
  await chrome.storage.local.set({ [QUEUE_STATS_KEY]: result });
}

/**
 * The replay queue's current backlog depth plus the last flush cycle's
 * outcome (see `recordFlushResult`). Not yet wired to a message action —
 * there is no `chatSyncQueueStatus` handler in service-worker.ts, since
 * `test/arch/message-senders.test.ts` requires a live sender in
 * `src/content/` or `src/popup/` before a whitelisted action can exist, and
 * this task's brief keeps `src/content/bootstrap.ts` and
 * `src/content/sync-icon.ts` off limits. Exported so whoever wires the icon
 * up to this can add the message plumbing (whitelist entry, `ExtensionMessage`
 * variant, `handleMessage` case) alongside their own sender, and call this
 * directly in the meantime (e.g. from a future popup panel).
 */
export async function getQueueStatus(): Promise<ChatSyncQueueStatus> {
  const stored = await chrome.storage.local.get([QUEUE_KEY, QUEUE_STATS_KEY]);
  const queue = normalizeQueue(stored[QUEUE_KEY]);
  const lastFlush: FlushQueueResult | null = stored[QUEUE_STATS_KEY] ?? null;
  return { queued: queue.length, lastFlush };
}
