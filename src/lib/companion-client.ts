/**
 * Client for the Mail API companion listener.
 *
 * Only ever called from the background service worker: a content script runs on
 * an https: page and cannot fetch http://127.0.0.1 (mixed content).
 */

import type { ChatBackfillRequest, ChatBackfillResponse, ChatSyncRequest, ChatSyncResponse } from './types';

const QUEUE_KEY = 'companionQueue';
const MAX_QUEUED = 50;

export interface CompanionSettings {
  companionUrl: string;
  companionToken: string;
}

/**
 * A non-OK response from the companion listener. Carries the server's
 * machine-readable `code` (e.g. `'conversation_locked'`) when the response
 * body included one, so a caller can tell apart two failures that share
 * the same HTTP status but need opposite retry handling — a locked
 * conversation is transient and worth replaying, while a 409 with no code
 * (a permanent client-side bug) must never be retried — without
 * re-deriving that distinction from the status alone.
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
  const detail = await response.text().catch(() => '');
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

export async function enqueue(request: ChatSyncRequest): Promise<void> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: ChatSyncRequest[] = stored[QUEUE_KEY] ?? [];
  const withoutStale = queue.filter(q => q.conversationId !== request.conversationId);
  withoutStale.push(request);
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
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: ChatSyncRequest[] = stored[QUEUE_KEY] ?? [];
  const withoutStale = queue.filter(q => q.conversationId !== conversationId);
  if (withoutStale.length !== queue.length) {
    await chrome.storage.local.set({ [QUEUE_KEY]: withoutStale });
  }
}

export async function flushQueue(settings: CompanionSettings): Promise<number> {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue: ChatSyncRequest[] = stored[QUEUE_KEY] ?? [];
  let sent = 0;
  const remaining: ChatSyncRequest[] = [];
  for (const request of queue) {
    try {
      await postSync(settings, request);
      sent += 1;
    } catch {
      remaining.push(request);
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  return sent;
}
