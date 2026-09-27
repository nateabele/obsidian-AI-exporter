/**
 * Background Service Worker
 * Handles HTTP communication with Obsidian REST API
 */

import { getErrorMessage } from '../lib/error-utils';
import { getSettings, migrateSettings } from '../lib/storage';
import { validateSender, validateMessageContent } from './validation';
import { handleTestConnection } from './obsidian-handlers';
import { handleMultiOutput } from './output-handlers';
import {
  postSync,
  postBackfill,
  enqueue,
  flushQueue,
  dropQueued,
  openNote,
  recordFlushResult,
  type CompanionSettings,
} from '../lib/companion-client';
import { handleFetchImage } from './image-fetch';
import type {
  ExtensionMessage,
  ContentScriptSettings,
  ExtensionSettings,
  ChatBackfillRequest,
  ChatBackfillResponse,
  ChatSyncRequest,
  ChatSyncResponse,
  FlushQueueResult,
} from '../lib/types';

// Run settings migration on service worker startup (C-01)
// Note: top-level await not available in service workers, use .catch() for error handling
migrateSettings().catch(error => {
  console.error('[G2O Background] Settings migration failed:', error);
});

/**
 * Log a flushQueue() cycle's outcome and persist it (see companion-client.ts's
 * recordFlushResult/getQueueStatus, the latter not yet wired to a message
 * action — see its doc comment) — the single place both the post-success
 * flush in handleChatSync and the alarm-driven flush below funnel through,
 * so neither path can go back to discarding the result the way the pre-fix
 * `await flushQueue(companion);` used to.
 */
async function reportFlushResult(result: FlushQueueResult): Promise<void> {
  if (result.refused > 0 || result.failed > 0 || result.exhausted > 0) {
    console.warn(
      `[G2O Background] Companion queue flush: ${result.sent} sent, ${result.refused} refused, ` +
        `${result.failed} failed, ${result.exhausted} exhausted, ${result.remaining} still queued`
    );
  } else if (result.sent > 0) {
    console.info(`[G2O Background] Companion queue flush: ${result.sent} queued sync(s) sent`);
  }
  await recordFlushResult(result);
}

/**
 * Name of the recurring alarm that drains the replay queue independent of
 * a live sync ever succeeding again. Without this, a companion that stayed
 * down would mean handleChatSync's post-success flush never runs a second
 * time, and the queue would sit there indefinitely with nothing to drain
 * it — no alarm, onStartup, or onInstalled flush existed before this.
 * `chrome.alarms` (rather than e.g. `setInterval`) is the idiomatic MV3
 * mechanism: it survives the service worker itself being torn down and
 * restarted between ticks, which a page-lifetime timer would not.
 *
 * Requires the `alarms` permission in manifest.json (added alongside this).
 */
const QUEUE_FLUSH_ALARM = 'g2oCompanionQueueFlush';
const QUEUE_FLUSH_PERIOD_MINUTES = 5;

// chrome.alarms.create with a name that already has a schedule is a no-op
// (it does not reset the period), so calling this on every service worker
// wake is safe and just re-asserts the same schedule rather than drifting
// it forward each time.
chrome.alarms.create(QUEUE_FLUSH_ALARM, { periodInMinutes: QUEUE_FLUSH_PERIOD_MINUTES });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== QUEUE_FLUSH_ALARM) return;
  flushQueueOnAlarm().catch(error => {
    console.error('[G2O Background] Alarm-driven companion queue flush failed:', error);
  });
});

async function flushQueueOnAlarm(): Promise<void> {
  const settings = await getSettings();
  // Nothing to flush against until the companion is configured — every
  // postSync would just throw "not configured" and inflate `failed`
  // without ever being able to succeed, until the queued entries exhaust
  // their attempts and get dropped for a reason that was never really
  // about *them*.
  if (!settings.companionToken) return;
  const result = await flushQueue({
    companionUrl: settings.companionUrl,
    companionToken: settings.companionToken,
  });
  await reportFlushResult(result);
}

/**
 * Handle incoming messages from content script and popup
 */
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // Ignore messages targeted at offscreen document
    // These are handled by the offscreen document's own listener
    if (
      message &&
      typeof message === 'object' &&
      'target' in message &&
      message.target === 'offscreen'
    ) {
      return false;
    }

    // Sender validation (M-02)
    if (!validateSender(sender)) {
      console.warn('[G2O Background] Rejected message from unauthorized sender');
      sendResponse({ success: false, error: 'Unauthorized' });
      return false;
    }

    // Message content validation (M-02)
    // A throw here would otherwise escape the listener and leave the sender
    // hanging without a response, so treat it as invalid content
    try {
      if (!validateMessageContent(message)) {
        console.warn('[G2O Background] Invalid message content');
        sendResponse({ success: false, error: 'Invalid message content' });
        return false;
      }
    } catch (error) {
      console.warn('[G2O Background] Message validation threw:', getErrorMessage(error));
      sendResponse({ success: false, error: 'Invalid message content' });
      return false;
    }

    handleMessage(message, sender)
      .then(response => {
        try {
          sendResponse(response);
        } catch {
          /* sender disconnected */
        }
      })
      .catch(error => {
        console.error('[G2O Background] Error handling message:', error);
        try {
          sendResponse({ success: false, error: getErrorMessage(error) });
        } catch {
          /* sender disconnected */
        }
      });
    return true; // Indicates async response
  }
);

/**
 * Check if sender is a content script (tab) vs extension page (popup)
 */
function isContentScriptSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab !== undefined;
}

/**
 * Whether a failed chatSync should be queued and replayed. False only for
 * a 409 with no `code` — chatSyncService's newBlocks-length mismatch, a
 * permanent client bug that would otherwise retry forever and hide it (see
 * CompanionApiError in `lib/companion-client.ts`). Every other failure
 * (a network error, any other status, or a 409 that DOES carry a
 * machine-readable code) is retryable, matching the queue's original
 * indiscriminate behavior. Duck-typed rather than importing
 * `isCompanionApiError` so this reads structurally off whatever error
 * shape actually arrives, without coupling to a specific class identity.
 */
function isRetryableCompanionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return true;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return !(status === 409 && code === undefined);
}

/**
 * Handle a `chatBackfill` request. Unlike chatSync, a backfill is a one-off,
 * user-initiated import (see the popup's "Import history" action and the
 * icon menu's "Repair this conversation from source") rather than a
 * continuous background loop, so there is no replay queue: a failure is
 * surfaced directly to the caller.
 *
 * There is deliberately no retry here. This once retried a 409
 * `conversation_locked` once after a delay, back when the companion took a
 * DB-backed per-conversation lock and rejected the loser. The companion now
 * serializes /sync and /backfill through one in-process queue instead: a
 * second caller simply awaits the first's settlement, so contention is
 * absorbed server-side and never reaches the extension as an error at all.
 * With that 409 gone, a client-side retry could only re-send failures that
 * are permanent (a codeless 409 is chatSyncService's newBlocks-length
 * mismatch) or better surfaced immediately (network, 5xx).
 */
function handleChatBackfill(
  data: ChatBackfillRequest,
  companion: CompanionSettings
): Promise<ChatBackfillResponse> {
  return postBackfill(companion, data);
}

/**
 * Redact sensitive settings for content scripts.
 * Content scripts only need to know IF an API key is configured, not the key itself.
 */
function redactSettingsForContentScript(settings: ExtensionSettings): ContentScriptSettings {
  const { obsidianApiKey, companionToken, ...syncSettings } = settings;
  return {
    ...syncSettings,
    isApiKeyConfigured: obsidianApiKey.length > 0,
    isCompanionConfigured: companionToken.length > 0,
  };
}

/**
 * Handle a `chatSync` request: post it to the companion, then reconcile the
 * retry queue on success. Failures are queued for replay unless
 * `isRetryableCompanionFailure` identifies them as a permanent client bug
 * (see that function's doc comment).
 */
async function handleChatSync(
  data: ChatSyncRequest,
  companion: CompanionSettings
): Promise<ChatSyncResponse> {
  try {
    const result = await postSync(companion, data);
    // Purge any queued (stale) entry for this conversation BEFORE flushing
    // the rest of the queue: replaying an older manifest after this newer
    // one has already landed would read as a divergence server-side and
    // demote the blocks we just synced to superseded.
    await dropQueued(data.conversationId);
    await reportFlushResult(await flushQueue(companion));
    return result;
  } catch (error) {
    // A 409 with no code is chatSyncService's newBlocks-length mismatch: a
    // permanent client-side bug. Queueing it here would retry forever and
    // hide the bug rather than surface it. A 409 that DOES carry a
    // machine-readable code is a deliberate, distinguishable server signal
    // and stays replayable. Anything else (a network failure, a non-409
    // status) has no code either but is retryable by default, matching the
    // queue's original indiscriminate behavior.
    if (isRetryableCompanionFailure(error)) {
      // Queueing the failed request must not mask the original failure — a
      // storage-quota error from enqueue() should never hide why the sync
      // itself failed. The original error still propagates below; the
      // top-level onMessage handler converts it into a MessageErrorResponse
      // for the caller.
      try {
        await enqueue(data);
      } catch (enqueueError) {
        console.error('[G2O Background] Failed to enqueue chatSync retry:', enqueueError);
      }
    }
    throw error;
  }
}

/**
 * Route messages to appropriate handlers
 */
async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  const settings = await getSettings();

  switch (message.action) {
    case 'saveToOutputs':
      return handleMultiOutput(message.data, message.outputs, settings);

    case 'testConnection':
      return handleTestConnection(settings);

    case 'fetchImage':
      // Remote images the content script cannot fetch itself (CORS, issue #376).
      return handleFetchImage(message.url);

    case 'getSettings':
      // Security: Redact API key for content scripts (they run on third-party pages)
      return isContentScriptSender(sender) ? redactSettingsForContentScript(settings) : settings;

    case 'chatSync':
      return handleChatSync(message.data, {
        companionUrl: settings.companionUrl,
        companionToken: settings.companionToken,
      });

    case 'chatBackfill':
      return handleChatBackfill(message.data, {
        companionUrl: settings.companionUrl,
        companionToken: settings.companionToken,
      });

    case 'openInObsidian': {
      // openNote throws on failure (missing token, non-OK response) rather
      // than resolving false, so a real failure here falls through to the
      // listener's outer `.catch` below, which turns it into a resolved
      // `{ success: false, error }` — the shape `onOpenPath` inspects to
      // show a toast, since a rejected promise from `sendMessage` never
      // actually occurs for either real failure mode (see MessageErrorResponse).
      await openNote(
        { companionUrl: settings.companionUrl, companionToken: settings.companionToken },
        message.data.path
      );
      return { success: true };
    }

    default:
      return { success: false, error: 'Unknown action' };
  }
}

// Log when service worker starts
console.info('[G2O Background] Service worker started');
