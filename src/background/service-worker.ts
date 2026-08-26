/**
 * Background Service Worker
 * Handles HTTP communication with Obsidian REST API
 */

import { getErrorMessage } from '../lib/error-utils';
import { getSettings, migrateSettings } from '../lib/storage';
import { validateSender, validateMessageContent } from './validation';
import { handleTestConnection } from './obsidian-handlers';
import { handleMultiOutput } from './output-handlers';
import { postSync, enqueue, flushQueue, dropQueued, openNote } from '../lib/companion-client';
import type { ExtensionMessage, ContentScriptSettings, ExtensionSettings } from '../lib/types';

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

    case 'chatSync': {
      const companion = {
        companionUrl: settings.companionUrl,
        companionToken: settings.companionToken,
      };
      try {
        const result = await postSync(companion, message.data);
        // Purge any queued (stale) entry for this conversation BEFORE flushing
        // the rest of the queue: replaying an older manifest after this newer
        // one has already landed would read as a divergence server-side and
        // demote the blocks we just synced to superseded.
        await dropQueued(message.data.conversationId);
        await flushQueue(companion);
        return result;
      } catch (error) {
        // Queueing the failed request must not mask the original failure —
        // a storage-quota error from enqueue() should never hide why the
        // sync itself failed. The original error still propagates below;
        // the top-level onMessage handler converts it into a
        // MessageErrorResponse for the caller.
        try {
          await enqueue(message.data);
        } catch (enqueueError) {
          console.error('[G2O Background] Failed to enqueue chatSync retry:', enqueueError);
        }
        throw error;
      }
    }

    case 'openInObsidian': {
      const success = await openNote(
        { companionUrl: settings.companionUrl, companionToken: settings.companionToken },
        message.data.path
      );
      return { success };
    }

    default:
      return { success: false, error: 'Unknown action' };
  }
}

// Log when service worker starts
console.info('[G2O Background] Service worker started');
