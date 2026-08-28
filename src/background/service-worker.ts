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
  type CompanionSettings,
} from '../lib/companion-client';
import type {
  ExtensionMessage,
  ContentScriptSettings,
  ExtensionSettings,
  ChatBackfillRequest,
  ChatBackfillResponse,
  ChatSyncRequest,
  ChatSyncResponse,
} from '../lib/types';
import { BACKFILL_LOCK_RETRY_DELAY } from '../lib/constants';

// Run settings migration on service worker startup (C-01)
// Note: top-level await not available in service workers, use .catch() for error handling
migrateSettings().catch(error => {
  console.error('[G2O Background] Settings migration failed:', error);
});

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
 * (a 409 that DOES carry a code, e.g. 'conversation_locked'; a network
 * error; any other status) is retryable, matching the queue's original
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
 * Whether a failed backfill lost a lock race and is worth one more try.
 *
 * Narrower than `isRetryableCompanionFailure` on purpose: a backfill has no
 * replay queue behind it, so this is the only retry it gets and it must be
 * spent on the one failure that is genuinely transient. That failure is
 * lock contention — the likeliest collision in the design is clicking
 * "Repair this conversation from source" on the conversation being viewed
 * while its own debounced auto-sync is still in flight, which the server
 * correctly answers with 409 `conversation_locked`. A codeless 409 is
 * chatSyncService's newBlocks-length mismatch, a permanent client bug that
 * must still never be retried; anything else (network, 5xx) is surfaced as
 * before rather than silently delaying the user's feedback.
 */
function isLockContentionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 409 && code === 'conversation_locked';
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Handle a `chatBackfill` request. Unlike chatSync, a backfill is a one-off,
 * user-initiated import (see the popup's "Import history" action and the
 * icon menu's "Repair this conversation from source") rather than a
 * continuous background loop, so there is no replay queue: a failure is
 * surfaced directly to the caller. The single exception is lock contention,
 * which is retried once after a short delay (see
 * `isLockContentionFailure`); if the retry also fails, that failure is what
 * the caller sees.
 */
async function handleChatBackfill(
  data: ChatBackfillRequest,
  companion: CompanionSettings
): Promise<ChatBackfillResponse> {
  try {
    return await postBackfill(companion, data);
  } catch (error) {
    if (!isLockContentionFailure(error)) {
      throw error;
    }
    await delay(BACKFILL_LOCK_RETRY_DELAY);
    return postBackfill(companion, data);
  }
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
    await flushQueue(companion);
    return result;
  } catch (error) {
    // A 409 with no code is chatSyncService's newBlocks-length mismatch: a
    // permanent client-side bug, not contention. Queueing it here would
    // retry forever and hide the bug rather than surface it — only a 409
    // that DOES carry a code (e.g. 'conversation_locked', when a backfill
    // or another sync holds this conversation) is transient enough to be
    // worth replaying. Anything else (a network failure, a non-409 status)
    // has no code either but is retryable by default, matching the queue's
    // original indiscriminate behavior.
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
