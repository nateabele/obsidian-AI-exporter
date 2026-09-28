/**
 * Conversation-change watcher (issue #458, ADR-034).
 *
 * Currently has no caller in src/: it was written for the status badge this
 * fork replaced with the sync icon, and navigation is handled instead by
 * `establishAutoSyncContext()` in bootstrap.ts, which resets the icon's
 * context off the same DOM mutations that already drive auto-sync. Kept rather
 * than deleted because the repair worker wants exactly this signal; if that
 * does not land, delete it — knip cannot report it, since every test file is
 * an entry (ADR-015).
 *
 * Polls `location.href` and reports when the *conversation* behind it changed.
 * See CONVERSATION_POLL_INTERVAL for why this is a poll and not an event.
 */

import { CONVERSATION_POLL_INTERVAL } from '../lib/constants';

/** Stops a running watcher. Safe to call more than once. */
export type StopWatching = () => void;

/**
 * Start watching for a conversation change.
 *
 * `getKey` is only consulted when `location.href` actually changed, so the
 * common case costs one string comparison per tick. A href change that leaves
 * the conversation id alone (a query parameter, a hash) is not a change.
 *
 * `initialKey` is supplied rather than read here: the conversation the
 * caller's state belongs to is the one that was synced — not whatever the DOM
 * happens to say by the time the watcher starts.
 */
export function startConversationWatcher(params: {
  /** Conversation the caller's state belongs to. */
  initialKey: string | null;
  /** Current conversation id, e.g. `extractor.getConversationId()`. */
  getKey: () => string | null;
  /** Called once each time the id differs from the previous one. */
  onChanged: (key: string | null) => void;
  intervalMs?: number;
}): StopWatching {
  const { initialKey, getKey, onChanged, intervalMs = CONVERSATION_POLL_INTERVAL } = params;

  let lastHref = window.location.href;
  let lastKey: string | null | undefined = initialKey;

  const timer = setInterval(() => {
    const href = window.location.href;
    if (href === lastHref) return;
    lastHref = href;

    const key = readKey(getKey);
    // `undefined` marks a read that failed; a throw mid-navigation says
    // nothing about whether the conversation changed, so leave lastKey alone
    // and re-check on the next href change.
    if (key === undefined || key === lastKey) return;

    lastKey = key;
    onChanged(key);
  }, intervalMs);

  return () => clearInterval(timer);
}

/** The current key, or `undefined` when the extractor could not be read. */
function readKey(getKey: () => string | null): string | null | undefined {
  try {
    return getKey();
  } catch (error) {
    console.debug('[G2O] Conversation key read failed:', error);
    return undefined;
  }
}
