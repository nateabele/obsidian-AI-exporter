/**
 * Client for the Mail API companion listener.
 *
 * Only ever called from the background service worker: a content script runs on
 * an https: page and cannot fetch http://127.0.0.1 (mixed content).
 */

import type { ChatSyncRequest, ChatSyncResponse } from './types';

const QUEUE_KEY = 'companionQueue';
const MAX_QUEUED = 50;

export interface CompanionSettings {
  companionUrl: string;
  companionToken: string;
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
    const detail = await response.text().catch(() => '');
    throw new Error(`Companion sync failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as ChatSyncResponse;
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
