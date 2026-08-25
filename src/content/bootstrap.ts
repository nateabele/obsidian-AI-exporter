/**
 * Content Script Bootstrap
 *
 * All content-script logic lives here so tests can import it without
 * triggering initialization; the import-time side effect (auto-start on
 * page load) is confined to the index.ts entry shim.
 */

import { GeminiExtractor } from './extractors/gemini';
import { ClaudeExtractor } from './extractors/claude';
import { ChatGPTExtractor } from './extractors/chatgpt';
import { PerplexityExtractor } from './extractors/perplexity';
import { NotebookLMExtractor } from './extractors/notebooklm';
import { extractErrorMessage } from '../lib/error-utils';
import type { IConversationExtractor } from '../lib/types';
import { conversationToNote } from './markdown';
import { showSuccessToast, showErrorToast, showWarningToast, showToast } from './ui';
import { injectSyncIcon, setSyncState, deriveState, getSuggestionCount } from './sync-icon';
import { sendMessage } from '../lib/messaging';
import {
  AUTO_SAVE_CHECK_INTERVAL,
  AUTO_SYNC_DEBOUNCE,
  EVENT_THROTTLE_DELAY,
  INFO_TOAST_DURATION,
  MUTATION_DEBOUNCE_DELAY,
} from '../lib/constants';
import type {
  AIPlatform,
  ChatSyncRequest,
  ChatSyncResponse,
  ContentScriptSettings,
  ObsidianNote,
  OutputDestination,
  OutputResult,
  MultiOutputResponse,
} from '../lib/types';
import { platformForHost } from '../lib/platform-registry';
import { throttle, debounce } from '../lib/throttle';
import { buildManifest, diffBlocks } from '../lib/manifest';

/**
 * Platform-specific main content container selectors for optimized observation.
 * Keyed by AIPlatform so the compiler enforces an entry per platform (ADR-014).
 */
const PLATFORM_ROOT_SELECTORS: Record<AIPlatform, string[]> = {
  gemini: ['main', '#app-container'],
  claude: ['main', '#__next'],
  chatgpt: ['main', '#__next'],
  perplexity: ['main', '#__next'],
  notebooklm: ['main', '#app-container'],
};

/**
 * Extractor constructors per platform. Lives here (not in the lib registry)
 * so lib/ stays free of content-layer imports (ADR-014).
 */
const EXTRACTOR_CONSTRUCTORS: Record<AIPlatform, new () => IConversationExtractor> = {
  gemini: GeminiExtractor,
  claude: ClaudeExtractor,
  chatgpt: ChatGPTExtractor,
  perplexity: PerplexityExtractor,
  notebooklm: NotebookLMExtractor,
};

/** Conversation container selectors to detect when content is ready */
const CONVERSATION_CONTAINER_SELECTOR =
  '.conversation-container, [class*="conversation"], section[data-turn-id], article[data-turn-id], div[class*="threadContentWidth"]';

/**
 * Get the optimal observation root for the current platform
 * Falls back to document.body if no platform-specific root is found
 */
function getObservationRoot(): Element {
  const platform = platformForHost(window.location.hostname);
  const selectors = platform ? PLATFORM_ROOT_SELECTORS[platform] : undefined;

  if (selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        console.debug(`[G2O] Using optimized observation root: ${selector}`);
        return element;
      }
    }
  }

  return document.body;
}

/**
 * Wait for conversation container to appear (L-03)
 * Uses MutationObserver with debouncing instead of fixed timeout
 *
 * Performance optimizations:
 * - Observes platform-specific root instead of document.body (P-1)
 * - Debouncing prevents excessive DOM queries during rapid mutation bursts
 */
function waitForConversationContainer(): Promise<void> {
  return new Promise(resolve => {
    // Check if already exists
    const existing = document.querySelector(CONVERSATION_CONTAINER_SELECTOR);
    if (existing) {
      resolve();
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Debounced check function
    const checkForContainer = (obs: MutationObserver) => {
      const container = document.querySelector(CONVERSATION_CONTAINER_SELECTOR);
      if (container) {
        obs.disconnect();
        if (debounceTimer) {
          window.clearTimeout(debounceTimer);
        }
        resolve();
      }
    };

    // Use MutationObserver to watch for container with debouncing
    const observer = new MutationObserver((_mutations, obs) => {
      // Clear previous debounce timer
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
      }
      // Schedule check after debounce delay
      debounceTimer = setTimeout(() => checkForContainer(obs), MUTATION_DEBOUNCE_DELAY);
    });

    // P-1: Observe platform-specific root instead of document.body for better performance
    const observationRoot = getObservationRoot();
    observer.observe(observationRoot, {
      childList: true,
      subtree: true,
    });

    // Fallback timeout
    setTimeout(() => {
      observer.disconnect();
      if (debounceTimer) {
        window.clearTimeout(debounceTimer);
      }
      resolve();
    }, AUTO_SAVE_CHECK_INTERVAL);
  });
}

/**
 * Get the appropriate extractor for the current page
 *
 * Uses strict hostname comparison to prevent subdomain attacks
 * @see CodeQL: js/incomplete-url-substring-sanitization
 */
export function getExtractor(): IConversationExtractor | null {
  // platformForHost uses strict hostname equality, which prevents attacks
  // like "evil-gemini.google.com.attacker.com"
  const platform = platformForHost(window.location.hostname);
  return platform ? new EXTRACTOR_CONSTRUCTORS[platform]() : null;
}

// Manifest of the last conversation state synced to the companion, kept
// module-level so an unchanged conversation costs nothing on repeated
// MutationObserver callbacks.
let previousManifest: string[] = [];
let lastHref = location.href;
// Re-entrancy guard: debounce serialises calls INTO runAutoSync but never
// awaits the previous invocation, so a slow postSync could otherwise let two
// invocations overlap and race on previousManifest. The next mutation
// re-triggers a fresh run once the in-flight one finishes.
let autoSyncInFlight = false;

// The auto-sync observer, tracked so a re-run of initialize() (or a test
// harness that drives it repeatedly against a shared document) disconnects
// the previous one instead of accumulating observers on the same root.
let autoSyncObserver: MutationObserver | null = null;
// The debounced runAutoSync callback, tracked so its pending trailing-edge
// timer can be cancelled alongside the observer (see stopAutoSync()).
let debouncedAutoSync: (((...args: unknown[]) => void) & { cancel: () => void }) | null = null;

/**
 * Stop the continuous auto-sync observer, if one is attached.
 *
 * Exported for test teardown: a shared jsdom document across a test file
 * would otherwise let an observer from one test fire on DOM mutations made
 * by a later, unrelated test (e.g. `clearFixture()`). Also cancels any
 * pending debounce timer so it can't fire after teardown.
 */
export function stopAutoSync(): void {
  autoSyncObserver?.disconnect();
  autoSyncObserver = null;
  debouncedAutoSync?.cancel();
  debouncedAutoSync = null;
}

/**
 * Send the chatSync request and update the sync icon to reflect the
 * outcome. Returns the response on success (and advances the manifest
 * baseline), or null on failure — the icon is already left in the
 * `offline` state with the error detail.
 */
async function sendChatSync(
  data: ChatSyncRequest,
  manifest: string[]
): Promise<ChatSyncResponse | null> {
  setSyncState('syncing');
  const response = await sendMessage({ action: 'chatSync', data });
  if ('error' in response) {
    console.warn('[G2O] Auto-sync failed:', response.error);
    setSyncState('offline', { error: response.error });
    return null;
  }
  // Only advance the baseline on confirmed success: advancing on a failed
  // send would mean the next successful sync diffs against blocks the
  // server never actually received, permanently losing them.
  previousManifest = manifest;
  const suggestionCount =
    response.suggestions.transcripts.length + response.suggestions.pages.length;
  setSyncState(deriveState({ configured: true, syncing: false, error: null, suggestionCount }), {
    suggestionCount,
    notePath: response.notePath,
  });
  return response;
}

/**
 * Return the icon to a resting state after a background auto-sync exits
 * early without ever reaching `sendChatSync` — e.g. an unchanged manifest,
 * the common case on a quiet page. Every early return in `runAutoSync` must
 * call this so `handleSync`'s `reportSyncOutcome()` can safely defer to an
 * in-flight auto-sync: that deferral is only correct if the in-flight run
 * is guaranteed to leave the icon in *some* terminal state, rather than
 * (as before this fix) sometimes leaving it stuck on `syncing` forever.
 */
function settleIcon(configured: boolean): void {
  setSyncState(
    deriveState({
      configured,
      syncing: false,
      error: null,
      suggestionCount: getSuggestionCount(),
    })
  );
}

/**
 * Whether the freshly-extracted manifest should actually be sent: false for
 * an unchanged manifest (nothing new since the last sync) or one that no
 * longer starts where the last synced manifest did. Both are routine, not
 * errors — split out from `runAutoSync` purely to keep it under the
 * line-count lint limit.
 */
function shouldSendManifest(manifest: string[]): boolean {
  const unchanged =
    manifest.length === previousManifest.length &&
    manifest.every((h, i) => h === previousManifest[i]);
  if (unchanged) return false;

  // Virtualized platforms (ADR-017) drop off-screen messages from the DOM,
  // so an extraction taken without scrolling can return a *window* of the
  // conversation instead of a prefix. A window that no longer starts where
  // the last synced manifest started mismatches at index 0, which the
  // server reads as a divergence and would supersede the ENTIRE transcript
  // over. Refuse to send rather than risk that.
  if (previousManifest.length > 0 && manifest[0] !== previousManifest[0]) {
    console.warn(
      '[G2O] Auto-sync skipped: manifest no longer starts where the previous one did ' +
        '(likely a virtualized window, not a true prefix) — not sending'
    );
    return false;
  }

  return true;
}

/**
 * Continuously sync the current conversation to the companion listener.
 *
 * Driven by a MutationObserver on the platform's observation root (see
 * `initialize()`), debounced by AUTO_SYNC_DEBOUNCE. Only sends an increment
 * when the manifest actually changed, so idle pages and unrelated DOM churn
 * cost nothing beyond a settings read and an extraction.
 */
export async function runAutoSync(): Promise<ChatSyncResponse | null> {
  // debounce() never awaits the previous call, so guard against two
  // invocations overlapping and racing on previousManifest — the next
  // mutation re-triggers a fresh run once this one finishes.
  if (autoSyncInFlight) return null;
  autoSyncInFlight = true;

  try {
    // SPAs navigate between conversations without a reload, so a manifest
    // built for the previous conversation must never be sent under the new
    // one's id.
    if (location.href !== lastHref) {
      previousManifest = [];
      lastHref = location.href;
    }

    const settings = await getSettings();
    if (!settings.isCompanionConfigured) {
      settleIcon(false);
      return null;
    }

    const extractor = getExtractor();
    if (!extractor || !extractor.canExtract()) {
      settleIcon(true);
      return null;
    }
    if (!settings.autoSyncPlatforms.includes(extractor.platform)) {
      settleIcon(true);
      return null;
    }

    // Auto-scroll is a good fit for the manual sync button (the user
    // triggered it and expects the page to move), but not for a background
    // cycle that fires every few seconds while the user is reading — force
    // it off here regardless of the user's setting.
    extractor.applySettings({ ...settings, enableAutoScroll: false });
    const result = await extractor.extract();
    if (!result.data) {
      settleIcon(true);
      return null;
    }

    const { manifest, blocks } = buildManifest(result.data.messages);
    if (!shouldSendManifest(manifest)) {
      settleIcon(true);
      return null;
    }

    return await sendChatSync(
      {
        conversationId: result.data.id,
        platform: result.data.source,
        title: result.data.title,
        url: result.data.url,
        manifest,
        newBlocks: diffBlocks(previousManifest, manifest, blocks),
      },
      manifest
    );
  } finally {
    autoSyncInFlight = false;
  }
}

/**
 * Start the content script when the DOM is ready.
 * Called once by the index.ts entry shim; exported so tests can drive it.
 */
export function startContentScript(): void {
  const startInit = () => {
    initialize().catch(error => {
      console.error('[G2O] Content script initialization failed:', error);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInit);
  } else {
    startInit();
  }
}

/**
 * Initialize the content script
 */
export async function initialize(): Promise<void> {
  console.info('[G2O] Content script initializing on:', window.location.hostname);

  // Check if we have a valid extractor for this page
  const extractor = getExtractor();
  if (!extractor) {
    console.info('[G2O] No extractor available for this page, skipping initialization');
    return;
  }

  console.info(`[G2O] Using ${extractor.platform} extractor`);

  // Wait for conversation container (L-03)
  await waitForConversationContainer();

  // Apply throttle to sync handler (NEW-06)
  const throttledHandleSync = throttle(handleSync, EVENT_THROTTLE_DELAY);
  injectSyncIcon({
    onOpenOptions: () =>
      showToast('Open the extension icon in the toolbar to add your companion token', 'info'),
    onRetry: () => void runAutoSync(),
    onSyncNow: () => void throttledHandleSync(),
    // Actually opening the note in Obsidian is wired up in Task 11 (the
    // `openInObsidian` message action doesn't exist yet); for now just
    // surface where it was saved.
    onOpenPath: path => showToast(`Note saved to ${path}`, 'info'),
  });
  console.info('[G2O] Sync icon injected');

  // Continuous background sync: drive runAutoSync off DOM mutations on the
  // same observation root used to detect the conversation container, so an
  // idle page costs nothing between edits. Debounced (trailing-edge only,
  // no max wait) rather than throttled: a streaming response mutates the
  // DOM continuously, and a leading-edge throttle would sync the first
  // partial token as if it were the finished message.
  stopAutoSync();
  debouncedAutoSync = debounce(runAutoSync, AUTO_SYNC_DEBOUNCE);
  autoSyncObserver = new MutationObserver(debouncedAutoSync);
  autoSyncObserver.observe(getObservationRoot(), { childList: true, subtree: true });
  console.info('[G2O] Auto-sync observer attached');
}

/**
 * Get enabled output destinations from settings
 */
function getEnabledOutputs(settings: ContentScriptSettings): OutputDestination[] {
  const outputs: OutputDestination[] = [];
  const { outputOptions } = settings;

  if (outputOptions?.obsidian) outputs.push('obsidian');
  if (outputOptions?.file) outputs.push('file');
  if (outputOptions?.clipboard) outputs.push('clipboard');

  return outputs;
}

/**
 * Validate output configuration before sync
 * @returns error message if invalid, null if valid
 */
async function validateOutputConfig(
  settings: ContentScriptSettings,
  enabledOutputs: OutputDestination[]
): Promise<string | null> {
  if (enabledOutputs.length === 0) {
    return 'Please select at least one output destination in settings';
  }

  if (enabledOutputs.includes('obsidian')) {
    if (!settings.isApiKeyConfigured) {
      return 'Please configure your Obsidian API key in the extension settings';
    }

    const connectionTest = await testConnection();
    if (!connectionTest.success) {
      return connectionTest.error || 'Cannot connect to Obsidian';
    }
  }

  return null;
}

/**
 * Display save results to the user via toasts
 */
function displaySaveResults(
  saveResult: MultiOutputResponse,
  fileName: string,
  extractionWarnings?: string[]
): void {
  // Show append-specific messages when applicable
  if (saveResult.allSuccessful && saveResult.messagesAppended !== undefined) {
    if (saveResult.messagesAppended > 0) {
      showToast(`${saveResult.messagesAppended} new message(s) appended`, 'success');
    } else {
      showToast('No new messages to append', 'info', INFO_TOAST_DURATION);
    }
  } else if (saveResult.allSuccessful) {
    // A filename collision may have forced an alternative name (issue #327):
    // show the name the note was actually saved under.
    const savedAs = saveResult.results.find(
      (r: OutputResult) => r.destination === 'obsidian'
    )?.savedAs;
    showSuccessToast(savedAs ?? fileName, true);
  } else if (saveResult.anySuccessful) {
    const successList = saveResult.results
      .filter((r: OutputResult) => r.success)
      .map((r: OutputResult) => r.destination)
      .join(', ');
    const failedList = saveResult.results
      .filter((r: OutputResult) => !r.success)
      .map((r: OutputResult) => `${r.destination}: ${r.error}`)
      .join('; ');
    showWarningToast(`Saved to: ${successList}. Failed: ${failedList}`);
  } else {
    const errorMsg = saveResult.results
      .map((r: OutputResult) => r.error)
      .filter(Boolean)
      .join('; ');
    showErrorToast(errorMsg || 'Failed to save');
  }

  if (extractionWarnings && extractionWarnings.length > 0 && saveResult.anySuccessful) {
    setTimeout(() => {
      showWarningToast(extractionWarnings.join('. '));
    }, INFO_TOAST_DURATION);
  }
}

/**
 * Reflect a manual sync's actual outcome on the icon.
 *
 * A failure always lands on `offline` with the error detail, so the icon
 * never lies about a sync that didn't succeed. A success derives its state
 * via `deriveState()` rather than hardcoding `synced`, so an existing
 * suggestion badge survives instead of being silently cleared. Skipped
 * entirely while a background `runAutoSync` is in flight — it owns the icon
 * state for that request and a concurrent manual sync must not race it.
 */
function reportSyncOutcome(errorMessage: string | null): void {
  if (autoSyncInFlight) return;
  if (errorMessage) {
    setSyncState('offline', { error: errorMessage });
    return;
  }
  const suggestionCount = getSuggestionCount();
  setSyncState(deriveState({ configured: true, syncing: false, error: null, suggestionCount }), {
    suggestionCount,
  });
}

/**
 * Run the manual-sync steps (settings → validate → extract → save),
 * returning the error message on failure or `null` on success. Split out
 * from `handleSync` purely to keep both under the line-count lint limit.
 */
async function performSync(): Promise<string | null> {
  // Get settings first (L-01: use type-safe messaging)
  const settings = await getSettings();
  const enabledOutputs = getEnabledOutputs(settings);

  // Validate output configuration
  const configError = await validateOutputConfig(settings, enabledOutputs);
  if (configError) {
    showErrorToast(configError);
    return configError;
  }

  // Extract conversation using appropriate extractor
  const extractor = getExtractor();
  if (!extractor || !extractor.canExtract()) {
    const message = 'Not on a valid conversation page';
    showErrorToast(message);
    return message;
  }

  showToast('Extracting conversation...', 'info', INFO_TOAST_DURATION);
  extractor.applySettings(settings);
  const result = await extractor.extract();

  // Validate extraction
  const validation = extractor.validate(result);
  if (!validation.isValid) {
    const message = validation.errors.join(', ') || 'Extraction failed';
    showErrorToast(message);
    return message;
  }

  if (validation.warnings.length > 0) {
    validation.warnings.forEach(warning => {
      console.warn('[G2O] Warning:', warning);
    });
  }

  if (!result.data) {
    const message = 'No conversation data extracted';
    showErrorToast(message);
    return message;
  }

  // Convert to Obsidian note
  const note = conversationToNote(result.data, settings.templateOptions);

  console.info('[G2O] Generated note:', {
    fileName: note.fileName,
    messageCount: result.data.messages.length,
    outputs: enabledOutputs,
  });

  // Save to enabled outputs
  showToast('Saving...', 'info', INFO_TOAST_DURATION);
  const saveResult = await saveToOutputs(note, enabledOutputs);
  const errorMessage = saveResult.anySuccessful
    ? null
    : saveResult.results
        .map((r: OutputResult) => r.error)
        .filter(Boolean)
        .join('; ') || 'Failed to save';

  displaySaveResults(saveResult, note.fileName, result.warnings);
  return errorMessage;
}

/**
 * Run `performSync()`, catching and reporting any thrown error the same way
 * a validation failure is reported — as an error message, never a rethrow.
 */
async function trySync(): Promise<string | null> {
  try {
    return await performSync();
  } catch (error) {
    console.error('[G2O] Sync error:', error);
    const message = extractErrorMessage(error);
    showErrorToast(message);
    return message;
  }
}

/**
 * Handle a manual sync request (icon menu's "Sync now" entry).
 */
export async function handleSync(): Promise<void> {
  console.info('[G2O] Sync initiated');
  if (!autoSyncInFlight) setSyncState('syncing');

  const errorMessage = await trySync();
  reportSyncOutcome(errorMessage);
}

/**
 * Get extension settings from background script (L-01)
 * Uses type-safe messaging utility
 */
function getSettings(): Promise<ContentScriptSettings> {
  return sendMessage({ action: 'getSettings' });
}

/**
 * Test connection to Obsidian (L-01)
 * Uses type-safe messaging utility
 */
function testConnection(): Promise<{ success: boolean; error?: string }> {
  return sendMessage({ action: 'testConnection' });
}

/**
 * Save note to multiple outputs via background script
 * Uses type-safe messaging utility
 */
function saveToOutputs(
  note: ObsidianNote,
  outputs: OutputDestination[]
): Promise<MultiOutputResponse> {
  return sendMessage({ action: 'saveToOutputs', data: note, outputs });
}
