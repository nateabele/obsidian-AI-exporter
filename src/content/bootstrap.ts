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
import { CONVERSATION_CONTAINER_SELECTOR } from './extractors/selectors/ready';
import { extractErrorMessage } from '../lib/error-utils';
import type { IConversationExtractor } from '../lib/types';
import { conversationToNote } from './markdown';
import { showSuccessToast, showErrorToast, showWarningToast, showToast } from './ui';
import {
  attachWatermarkWatcher,
  injectSyncIcon,
  paintFor,
  deriveState,
  getSuggestionCount,
  getLastError,
  getLastBlockedReason,
  setIconContext,
  setSuggestions,
  suggestionCount,
} from './sync-icon';
import type { StopWatching } from './conversation-watcher';
import { sendMessage, isMultiOutputResponse, describeUnexpectedResponse } from '../lib/messaging';
import {
  AUTO_SAVE_CHECK_INTERVAL,
  AUTO_SYNC_DEBOUNCE,
  EVENT_THROTTLE_DELAY,
  INFO_TOAST_DURATION,
  MUTATION_DEBOUNCE_DELAY,
} from '../lib/constants';
import type {
  AIPlatform,
  ChatSyncBlock,
  ChatSyncRequest,
  ChatSyncResponse,
  ContentScriptSettings,
  ConversationData,
  ExtractionResult,
  ObsidianNote,
  OutputDestination,
  OutputResult,
  MultiOutputResponse,
} from '../lib/types';
import { platformForHost } from '../lib/platform-registry';
import { throttle, debounce } from '../lib/throttle';
import { ARCHIVE_SUPPORTED_PLATFORMS } from '../lib/constants';
import { buildManifest, diffBlocks } from './manifest';
import { getMessage } from '../lib/i18n';
import { registerArchiveDiscoveryListener, fetchConversationForRepair } from './archive/discover';

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
 * Our own injected UI, which lives on document.body rather than inside any
 * platform container.
 */
const OWN_UI_SELECTOR = '#g2o-sync-icon, #g2o-sync-menu';

function isOwnUi(node: Node): boolean {
  // characterData mutations target text nodes, which have no closest().
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(OWN_UI_SELECTOR) != null;
}

/**
 * True when a mutation was caused by our own UI rather than the page.
 *
 * getObservationRoot() falls back to document.body, and both the sync icon
 * and its menu are appended to document.body -- so on that fallback the
 * auto-sync observer watches its own output. Every icon repaint mutates the
 * observed subtree, retriggers the debounce, and runAutoSync repaints the
 * icon again: a self-sustaining loop that burns CPU on an idle page for as
 * long as the tab is open. Selector drift is the likeliest failure mode this
 * project has, so the fallback must be safe, not merely present.
 *
 * A batch is only ignored when EVERY record in it is self-inflicted. A real
 * message arriving in the same batch as a repaint must still sync, or the
 * message is lost.
 */
export function isSelfInflictedMutation(record: MutationRecord): boolean {
  if (isOwnUi(record.target)) return true;
  const touched = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  return touched.length > 0 && touched.every(isOwnUi);
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
// Conversation ids auto-repair has already been tried for, and the subset it
// stored successfully. Content-script lifetime, never cleared: the first set
// makes a failing or skipped repair impossible to loop, the second lets a
// repaired conversation absorb later scroll-window shifts (see maybeAutoRepair).
const autoRepairAttempted = new Set<string>();
const autoRepaired = new Set<string>();

// The auto-sync observer, tracked so a re-run of initialize() (or a test
// harness that drives it repeatedly against a shared document) disconnects
// the previous one instead of accumulating observers on the same root.
let autoSyncObserver: MutationObserver | null = null;
// The debounced runAutoSync callback, tracked so its pending trailing-edge
// timer can be cancelled alongside the observer (see stopAutoSync()).
let debouncedAutoSync: (((...args: unknown[]) => void) & { cancel: () => void }) | null = null;
// Stops the watermark watcher armed by the last successful sync, or null when
// none is armed. Module-level because the watcher deliberately outlives the
// `runAutoSync()` call that started it: it exists to invalidate what that call
// painted, once the conversation grows past it (issues #465/#468).
let stopWatermarkWatcher: StopWatching | null = null;

/**
 * Stop the continuous auto-sync observer, if one is attached.
 *
 * Exported for test teardown: a shared jsdom document across a test file
 * would otherwise let an observer from one test fire on DOM mutations made
 * by a later, unrelated test (e.g. `clearFixture()`). Also cancels any
 * pending debounce timer, and disarms the watermark watcher's poll, so
 * neither can fire after teardown.
 */
export function stopAutoSync(): void {
  autoSyncObserver?.disconnect();
  autoSyncObserver = null;
  debouncedAutoSync?.cancel();
  debouncedAutoSync = null;
  stopWatermarkWatch();
}

/** Disarm the watermark watcher, if one is armed. Safe to call repeatedly. */
function stopWatermarkWatch(): void {
  stopWatermarkWatcher?.();
  stopWatermarkWatcher = null;
}

/** The highest turn ordinal currently mounted, or null on platforms without one. */
function currentMessageWatermark(): number | null {
  return getExtractor()?.getMessageWatermark() ?? null;
}

/**
 * Arm the watermark watcher for the conversation a sync just covered, so a
 * message arriving afterwards drops the `synced` paint instead of leaving a
 * partial sync indistinguishable from a complete one (issues #465/#468).
 *
 * `syncedWatermark` comes from the extraction that was sent, never a DOM read
 * taken after it: the auto-scroll pass ends pinned at the TOP of the
 * conversation, where the newest turn is unmounted and its ordinal is gone.
 *
 * Re-armed, never stacked — the previous watcher is stopped first. Two pollers
 * for the same signal would poll twice and paint twice, and the older one's
 * baseline is by definition staler than this one's.
 */
function armWatermarkWatcher(href: string, syncedWatermark: number | null): void {
  stopWatermarkWatch();
  stopWatermarkWatcher = attachWatermarkWatcher(href, syncedWatermark, currentMessageWatermark);
}

/**
 * Send the chatSync request and update the sync icon to reflect the
 * outcome. Returns the response on success (and advances the manifest
 * baseline), or null on failure — the icon is already left in the
 * `offline` state with the error detail.
 *
 * `href` is the href the caller captured before starting — this spans two
 * `await`s (the request itself), during which the SPA may have navigated to
 * a different conversation, so every paint below goes through `paintFor()`
 * rather than `setSyncState()` and is dropped if it has.
 *
 * `blocks` is the FULL set of blocks for the whole current manifest (not
 * just `data.newBlocks`, which may be a diff) — kept alongside `data` so a
 * `needsFullContent` response (the stored blocks were produced by a
 * different producer, e.g. a prior backfill, whose hashes cannot be
 * compared against this manifest) can be answered by resending every
 * block, once. `isRetry` guards against looping: a second
 * `needsFullContent` in the same attempt is treated as a failure rather
 * than resent again.
 */
async function sendChatSync(
  data: ChatSyncRequest,
  manifest: string[],
  blocks: ChatSyncBlock[],
  href: string,
  isRetry = false
): Promise<ChatSyncResponse | null> {
  paintFor(href, 'syncing');
  const response = await sendMessage({ action: 'chatSync', data });
  if ('error' in response) {
    console.warn('[G2O] Auto-sync failed:', response.error);
    paintFor(href, 'offline', { error: response.error });
    return null;
  }
  if (response.mode === 'needsFullContent') {
    if (isRetry) {
      console.warn(
        '[G2O] Auto-sync failed: server asked for full content twice in the same attempt'
      );
      paintFor(href, 'offline', { error: getMessage('syncIcon_fullContentLoop') });
      return null;
    }
    return sendChatSync({ ...data, newBlocks: blocks }, manifest, blocks, href, true);
  }
  // A non-empty `newBlocks` means the client expected the server to append
  // or diverge. A `noop` response to that is not a genuine "nothing
  // changed" — it means the server rejected the delta (e.g. a windowed
  // manifest sent right after a page reload, before `previousManifest` has
  // been rebuilt, on a virtualized long conversation). Treat it as a stall:
  // do NOT advance the baseline (the server never stored anything, so
  // diffing the next sync against it would skip real content), and surface
  // an error so the user knows to scroll up or run a manual export instead
  // of trusting a silently-green icon.
  if (data.newBlocks.length > 0 && response.mode === 'noop') {
    console.warn('[G2O] Auto-sync stalled: server reported no-op for a non-empty delta');
    paintFor(href, 'offline', { error: getMessage('syncIcon_syncStalled') });
    return null;
  }
  // Only advance the baseline on confirmed success: advancing on a failed
  // send would mean the next successful sync diffs against blocks the
  // server never actually received, permanently losing them.
  previousManifest = manifest;
  // setSuggestions() first so suggestionCount() below reflects this
  // response, not whatever the previous sync (or conversation) left behind.
  // Pass href so a slow response for a conversation the user has since left
  // no-ops instead of clobbering the current conversation's suggestions.
  setSuggestions(href, response.suggestions);
  const count = suggestionCount();
  paintFor(
    href,
    deriveState({ configured: true, syncing: false, error: null, suggestionCount: count }),
    {
      suggestionCount: count,
      notePath: response.notePath,
      // This is a real, confirmed success — resolve any error a previous
      // attempt left behind, rather than leaving it retained for a later
      // bail-out to reassert. `blocked` is resolved for the same reason and
      // must be passed explicitly: `setSyncState` leaves an absent one alone,
      // so without this the watermark watcher's "the conversation grew"
      // reason would outlive the very sync that answered it and sit in the
      // tooltip under a tick for the rest of the conversation.
      error: null,
      blocked: null,
    }
  );
  return response;
}

/**
 * Return the icon to a resting state after a background auto-sync exits
 * early without ever reaching `sendChatSync` — e.g. an unchanged manifest,
 * the common case on a quiet page. Every early return in `runAutoSync` must
 * call this, or one of its siblings below (`settleBlocked`/`settleDisabled`),
 * so `handleSync`'s `reportSyncOutcome()` can safely defer to an in-flight
 * auto-sync: that deferral is only correct if the in-flight run is
 * guaranteed to leave the icon in *some* terminal state, rather than (as
 * before this fix) sometimes leaving it stuck on `syncing` forever.
 *
 * Reserved for bail-outs that genuinely have nothing new to report — an
 * unconfigured companion, or an unchanged manifest — as opposed to
 * `settleBlocked`, for a bail-out that DOES know something specific went
 * wrong this tick.
 */
function settleIcon(configured: boolean, href: string): void {
  // A bail-out never checked whether the last attempt actually failed, so
  // it must not assert `error: null` — that would silently clear a real,
  // still-unresolved error off the icon (e.g. a failed manual sync,
  // immediately overwritten by the next quiet background tick). Passing no
  // `detail` to paintFor below leaves the retained error untouched either
  // way.
  //
  // The retained `blocked` reason is passed for exactly the same reason, and
  // it is load-bearing rather than defensive: omitting it makes `deriveState`
  // read "nothing is blocking" and fall through to the quiet `synced`
  // default, so an unchanged-manifest tick would repaint `synced` over a
  // conversation the watermark watcher had just invalidated (#465/#468) — the
  // one sibling of this function that CAN claim `synced`. Only a confirmed
  // success clears the reason (see `sendChatSync`).
  paintFor(
    href,
    deriveState({
      configured,
      syncing: false,
      error: getLastError(),
      suggestionCount: getSuggestionCount(),
      blocked: getLastBlockedReason(),
    })
  );
}

/**
 * Settle the icon on `attention` (or whatever `deriveState` derives instead —
 * see below) after a bail-out that knows a SPECIFIC, fresh reason this tick
 * could not even attempt a real sync: a rotted `canExtract()`, an extraction
 * that yielded no data, or a manifest window that can't be safely diffed
 * (see `decideManifestSend`). Unlike `settleIcon`'s deferral to whatever the
 * last resolved attempt left behind, `reason` is asserted here every time —
 * it describes what just happened, not a guess about stale state.
 *
 * Still passes the retained `error` (via `getLastError()`) through to
 * `deriveState`, so a genuine unresolved connectivity failure continues to
 * outrank a same-tick local blockage rather than being silently papered
 * over by it (see `deriveState`'s precedence comment).
 */
function settleBlocked(href: string, reason: string): void {
  paintFor(
    href,
    deriveState({
      configured: true,
      syncing: false,
      error: getLastError(),
      suggestionCount: getSuggestionCount(),
      blocked: reason,
    }),
    { blocked: reason }
  );
}

/**
 * Settle the icon on `disabled` (or whatever `deriveState` derives instead)
 * after auto-sync is skipped because the current platform is deliberately
 * excluded from `autoSyncPlatforms`. No `reason` to retain — unlike
 * `settleBlocked`, the note shown for this state (see
 * `syncIcon_autoSyncDisabled`) is fixed, not derived from what happened this
 * tick — so there is nothing here to pass as `detail`.
 */
function settleDisabled(href: string): void {
  paintFor(
    href,
    deriveState({
      configured: true,
      syncing: false,
      error: getLastError(),
      suggestionCount: getSuggestionCount(),
      disabled: true,
    })
  );
}

/**
 * Settle the icon after `runAutoSync`'s try block throws — `getSettings()`
 * and `sendMessage()` (inside `sendChatSync`) both REJECT on
 * extension-context invalidation (e.g. after an extension reload/update —
 * see messaging.ts) or any other unexpected messaging failure. Every caller
 * of `runAutoSync` is `void runAutoSync()` or driven through `debounce()`
 * (neither awaits nor catches), so without a catch calling this, a rejection
 * here would surface only as an unhandled promise rejection — no paint at
 * all, leaving the icon frozen on whatever it last showed (often `synced`)
 * forever. This isn't a local extraction blockage (`attention`); it's the
 * same flavor of failure a resolved `{ error }` chatSync response already
 * paints, so it reuses `offline` rather than inventing a third failure state
 * for what is, from the user's side, the same "a sync attempt failed" story.
 */
function settleAutoSyncFailure(href: string, error: unknown): void {
  const message = extractErrorMessage(error);
  console.error('[G2O] Auto-sync failed:', error);
  paintFor(href, 'offline', { error: message });
}

/**
 * Whether `href` is still the page the user is looking at. Used to guard
 * every user-visible side effect of `repairConversation` that isn't already
 * routed through `paintFor()` (which does its own, separate href check) —
 * a toast has no equivalent guard built in, so without this an in-app
 * navigation mid-repair would pop a toast about a conversation the user has
 * since left, the same stale-result bug the icon's `paintFor()` convention
 * exists to prevent, just in a channel that convention doesn't cover.
 */
function isStillCurrent(href: string): boolean {
  return href === location.href;
}

/**
 * Run the icon menu's "Repair this conversation from source" action: an
 * authoritative single-conversation re-import via the platform's own API
 * (`fetchConversationForRepair`, `src/content/archive/`), for when the
 * live-DOM sync has drifted or missed something and the whole transcript
 * needs to be re-derived from the source of truth rather than patched.
 *
 * `href` is captured by the caller before either `await` below — an
 * in-app navigation mid-fetch must not let this repair's outcome paint
 * onto whatever conversation is now on screen, so every result here goes
 * through `paintFor()`, never `setSyncState()` directly (see
 * `test/arch/sync-icon-invariants.test.ts`), and every toast is guarded by
 * `isStillCurrent()` for the same reason.
 *
 * A `skipped` response (the server refuses a conversation containing a
 * truncated message, or with no messages at all, and writes nothing) is a
 * normal outcome, not a failure: it is reported via a toast rather than the
 * icon's retained `error` field, because setting `error` here would make
 * `settleIcon()` derive `offline` on every later quiet auto-sync tick until
 * some future success or failure happened to clear it — turning a benign
 * skip into a phantom, indefinitely-stuck connection failure.
 *
 * A genuine failure (thrown or reported) is surfaced both on the icon and
 * as an error toast — matching `handleSync`'s manual-sync path — because
 * this action was explicitly clicked to fix a bad transcript; if it fails,
 * quietly doing nothing is the exact failure mode it exists to correct, and
 * an icon tooltip alone is too easy to miss.
 */
async function repairConversation(href: string, conversationId: string): Promise<boolean> {
  paintFor(href, 'syncing');
  try {
    const request = await fetchConversationForRepair(conversationId);
    const response = await sendMessage({ action: 'chatBackfill', data: request });
    if ('error' in response) {
      console.warn('[G2O] Repair failed:', response.error);
      if (isStillCurrent(href)) showErrorToast(response.error);
      paintFor(href, 'offline', { error: response.error });
      return false;
    }

    const suggestionCountAfter = getSuggestionCount();
    const settledState = deriveState({
      configured: true,
      syncing: false,
      error: null,
      suggestionCount: suggestionCountAfter,
    });
    if (response.skipped) {
      if (isStillCurrent(href)) {
        showToast(getMessage('syncIcon_repairSkipped', [response.skipped]), 'info');
      }
      paintFor(href, settledState, {
        error: null,
        blocked: null,
        suggestionCount: suggestionCountAfter,
      });
      return false;
    }
    paintFor(href, settledState, {
      notePath: response.notePath ?? undefined,
      error: null,
      blocked: null,
      suggestionCount: suggestionCountAfter,
    });
    return true;
  } catch (error) {
    const message = extractErrorMessage(error);
    console.error('[G2O] Repair failed:', error);
    if (isStillCurrent(href)) showErrorToast(message);
    paintFor(href, 'offline', { error: message });
    return false;
  }
}

/**
 * Handle a click on the icon menu's "Repair this conversation from source"
 * entry (`SyncIconHandlers.onRepair`).
 *
 * Only wired into `injectSyncIcon()` for a platform with a working
 * `ArchiveAdapter` (see `initialize()`), so — unlike the conversation id
 * below — there is no unsupported-platform case left to check here: the
 * platform can't change without a full page reload, which starts a fresh
 * content-script instance.
 *
 * The conversation id, in contrast, is re-resolved here — fresh, at click
 * time, from the live DOM — rather than captured once when the icon was
 * injected: the SPA can navigate between conversations without a reload, so
 * a stale id captured at page-load time could silently repair the wrong (or
 * no longer open) conversation. `canRepair` (see `initialize()`) keeps the
 * menu entry itself from being offered when this would fail, so reaching
 * this branch means the id disappeared in the narrow window between the
 * menu being built and this click — a live safety net, not the primary
 * defense.
 */
function handleRepairClick(): void {
  const startHref = location.href;
  const conversationId = getExtractor()?.getConversationId();
  if (!conversationId) {
    paintFor(startHref, 'offline', { error: getMessage('syncIcon_repairNoConversationId') });
    return;
  }
  void repairConversation(startHref, conversationId);
}

/**
 * The reason to surface via `settleBlocked` when `extractor.extract()`
 * returns no data — prefers the extractor's own `result.error`, then its
 * `result.warnings` (joined), and only falls back to a generic message if
 * neither is present. Surfacing these rather than a hardcoded string is the
 * whole point of this fix: `result.error`/`result.warnings` used to be read
 * by nobody on this path, which is exactly how a rotted selector (e.g.
 * `base.ts`'s "Primary selectors may have changed" warning) could paint
 * `synced` indefinitely. Split out from `runAutoSync` purely to keep it
 * under the line-count lint limit.
 */
function extractionFailureReason(result: ExtractionResult): string {
  if (result.error) return result.error;
  if (result.warnings && result.warnings.length > 0) return result.warnings.join('; ');
  return getMessage('syncIcon_extractionFailed');
}

/**
 * Build the `chatSync` request body for the current manifest/blocks. Split
 * out from `runAutoSync` purely to keep it under the line-count lint limit.
 */
function buildChatSyncRequest(
  data: ConversationData,
  manifest: string[],
  blocks: ChatSyncBlock[]
): ChatSyncRequest {
  return {
    conversationId: data.id,
    platform: data.source,
    title: data.title,
    url: data.url,
    manifest,
    newBlocks: diffBlocks(previousManifest, manifest, blocks),
  };
}

/**
 * Send the increment and, on a confirmed success, arm the watermark watcher
 * for the newest turn it covered, so a message arriving afterwards drops the
 * `synced` paint (issues #465/#468). Nothing is armed for a failed send: the
 * icon is on `offline`, so there is no `synced` claim for a later turn to
 * invalidate.
 *
 * The watermark comes from `data` — the extraction that was actually sent —
 * never a DOM read taken here (see `armWatermarkWatcher`). Split out from
 * `runAutoSync` purely to keep it under the line-count lint limit.
 */
async function sendAndWatch(
  data: ConversationData,
  manifest: string[],
  blocks: ChatSyncBlock[],
  href: string
): Promise<ChatSyncResponse | null> {
  const response = await sendChatSync(
    buildChatSyncRequest(data, manifest, blocks),
    manifest,
    blocks,
    href
  );
  if (response) armWatermarkWatcher(href, data.messageWatermark ?? null);
  return response;
}

/**
 * Whether — and why not — the freshly-extracted manifest should actually be
 * sent:
 * - `'unchanged'`: nothing new since the last sync, the common case on a
 *   quiet page. Routine; `runAutoSync` settles the icon via `settleIcon`.
 * - `'windowed'`: the manifest looks like a virtualized window rather than a
 *   true growth of the last synced manifest (see below) — sending it would
 *   risk corrupting the server's copy, or silently stop tracking messages
 *   the client no longer has any record of. Not routine: `runAutoSync`
 *   settles the icon via `settleBlocked`, surfacing it rather than staying
 *   silently green.
 * - `'headShifted'`: the head-shift flavour of `'windowed'` — the manifest no
 *   longer starts where the last one did, i.e. earlier turns mounted (the user
 *   scrolled up). Handled like `'windowed'` unless `maybeAutoRepair` can
 *   recover it from the platform API. Tail truncation stays `'windowed'`.
 * - `'send'`: safe to diff and send.
 *
 * Split out from `runAutoSync` purely to keep it under the line-count lint
 * limit.
 */
type ManifestSendDecision = 'send' | 'unchanged' | 'windowed' | 'headShifted';

function decideManifestSend(manifest: string[]): ManifestSendDecision {
  const unchanged =
    manifest.length === previousManifest.length &&
    manifest.every((h, i) => h === previousManifest[i]);
  if (unchanged) return 'unchanged';

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
    return 'headShifted';
  }

  // The sibling truncation: the window narrowed from the TAIL instead of
  // the head — every hash still present matches the start of
  // `previousManifest`, but there are fewer of them (messages scrolled out
  // of view and virtualized away). `diffBlocks` against this would compute
  // an EMPTY delta (nothing beyond `divergeAt` to slice), so a caller that
  // didn't check for this and sent anyway would get back a harmless-looking
  // response and advance `previousManifest` to this truncated manifest —
  // poisoning the baseline for every later comparison, since the next real
  // diff would then treat already-synced messages beyond this point as
  // "new" (see the regression pin for this in index.test.ts). Refuse here,
  // before a diff is ever computed, exactly like the head-shift case above.
  if (
    previousManifest.length > manifest.length &&
    manifest.every((h, i) => h === previousManifest[i])
  ) {
    console.warn(
      '[G2O] Auto-sync skipped: manifest shrank to a prefix of the previous one ' +
        '(likely virtualized tail truncation) — not sending, not advancing the baseline'
    );
    return 'windowed';
  }

  return 'send';
}

/**
 * Claude (and ChatGPT) virtualize the thread, so the first auto-sync after a
 * page load can only see the mounted tail; sent as-is it would be stored as the
 * whole conversation, and scrolling up later prepends turns that no diff can
 * recover (`'headShifted'`, forever). This recovers from the platform API
 * instead, via the same path as the icon menu's "Repair from source".
 *
 * Fires, at most once per conversation per content-script lifetime, when the
 * platform has an archive adapter, a conversation id resolves, and either:
 * - this is the first sync for the href and the window does not start at turn 0
 *   (nothing is sent first — the partial chatSync is exactly what to avoid), or
 * - earlier turns appeared (`'headShifted'`).
 *
 * After a stored repair the server holds the full conversation, so the current
 * window is adopted as the baseline WITHOUT sending: sending it would trip the
 * server's backfill-agreement guard (`needsFullContent`) for no gain, and a
 * later scroll shifts the head again. Once repaired, a further `'headShifted'`
 * is therefore absorbed the same way instead of stalling the icon.
 *
 * Resolves `true` when it consumed the tick (the caller returns), `false` to
 * fall through to the normal handling — which is today's behaviour, including
 * once the once-only guard is spent.
 */
async function maybeAutoRepair(
  extractor: IConversationExtractor,
  decision: ManifestSendDecision,
  manifest: string[],
  href: string
): Promise<boolean> {
  if (!ARCHIVE_SUPPORTED_PLATFORMS.includes(extractor.platform)) return false;
  const conversationId = extractor.getConversationId();
  if (!conversationId) return false;

  if (decision === 'headShifted' && autoRepaired.has(conversationId)) {
    previousManifest = manifest;
    settleIcon(true, href);
    return true;
  }

  const lowest = extractor.getLowestMountedIndex();
  const firstPartialWindow =
    decision === 'send' && previousManifest.length === 0 && lowest !== null && lowest > 0;
  if (!firstPartialWindow && decision !== 'headShifted') return false;
  if (autoRepairAttempted.has(conversationId)) return false;
  autoRepairAttempted.add(conversationId);

  if (await repairConversation(href, conversationId)) {
    autoRepaired.add(conversationId);
    // An in-app navigation mid-repair has already reset the baseline for the
    // new conversation; writing this one's manifest would poison it.
    if (isStillCurrent(href)) previousManifest = manifest;
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
// SPAs navigate between conversations without a reload, so a manifest built
// for the previous conversation must never be sent under the new one's id.
// Called from `runAutoSync` BEFORE its re-entrancy guard — not after — so a
// navigation arriving while a previous run is still in flight is never
// swallowed: the icon context updates right here regardless, and that
// in-flight run's own paints (captured under the stale href it started
// under) become no-ops via `paintFor()` the moment the context moves on.
function establishAutoSyncContext(startHref: string): void {
  if (startHref !== lastHref) {
    previousManifest = [];
    lastHref = startHref;
    setIconContext(startHref);
    // The watermark watcher belongs to the conversation that was synced, whose
    // ordinals say nothing about this one. Its paints are already no-ops after
    // setIconContext above, so leaving it polling would be pure waste.
    stopWatermarkWatch();
  }
}

export async function runAutoSync(): Promise<ChatSyncResponse | null> {
  const startHref = location.href;
  establishAutoSyncContext(startHref);

  // debounce() never awaits the previous call, so guard against two
  // invocations overlapping and racing on previousManifest — the next
  // mutation re-triggers a fresh run once this one finishes.
  if (autoSyncInFlight) return null;
  autoSyncInFlight = true;

  try {
    const settings = await getSettings();
    if (!settings.isCompanionConfigured) {
      settleIcon(false, startHref);
      return null;
    }

    const extractor = getExtractor();
    if (!extractor || !extractor.canExtract()) {
      // Ambiguous by construction: every extractor's `canExtract()` today
      // just re-checks the hostname (see e.g. GeminiExtractor), which
      // cannot itself change mid-session — so in practice this never fires.
      // If a future extractor makes it richer (e.g. also requiring a
      // resolvable conversation id), this branch would then cover BOTH "not
      // actually on a conversation page right now" (expected) and "the
      // selectors it depends on rotted" (not). Since this bail-out can't
      // tell those apart, and the harm of wrongly claiming `synced` is worse
      // than the harm of an occasional false `attention`, treat it as
      // blocked rather than assume the benign case.
      settleBlocked(startHref, getMessage('syncIcon_notOnConversationPage'));
      return null;
    }
    if (!settings.autoSyncPlatforms.includes(extractor.platform)) {
      // Unlike the branches above and below, this one IS unambiguous: the
      // user deliberately excluded this platform from auto-sync in
      // settings. Genuinely nothing was attempted, on purpose — that's
      // `disabled`, not `attention`.
      settleDisabled(startHref);
      return null;
    }

    // Auto-scroll is a good fit for the manual sync button (the user
    // triggered it and expects the page to move), but not for a background
    // cycle that fires every few seconds while the user is reading — force
    // it off here regardless of the user's setting.
    extractor.applySettings({ ...settings, enableAutoScroll: false });
    const result = await extractor.extract();
    if (!result.data) {
      settleBlocked(startHref, extractionFailureReason(result));
      return null;
    }

    const { manifest, blocks } = buildManifest(result.data.messages);
    const manifestDecision = decideManifestSend(manifest);
    if (manifestDecision === 'unchanged') {
      settleIcon(true, startHref);
      return null;
    }
    if (await maybeAutoRepair(extractor, manifestDecision, manifest, startHref)) return null;
    if (manifestDecision === 'windowed' || manifestDecision === 'headShifted') {
      settleBlocked(startHref, getMessage('syncIcon_syncStalled'));
      return null;
    }

    return await sendAndWatch(result.data, manifest, blocks, startHref);
  } catch (error) {
    settleAutoSyncFailure(startHref, error);
    return null;
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

  // Registered before the conversation-container wait below (which can
  // block indefinitely on a page with no open conversation, e.g. a
  // history/listing view): the popup's "Import history" action needs to
  // reach this listener even when no conversation is open on the tab.
  registerArchiveDiscoveryListener();

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
  const throttledSyncNow = throttle(() => void runAutoSync(), EVENT_THROTTLE_DELAY);
  injectSyncIcon({
    onOpenOptions: () =>
      showToast('Open the extension icon in the toolbar to add your companion token', 'info'),
    onRetry: () => void runAutoSync(),
    onSyncNow: () => throttledSyncNow(),
    onOpenPath: path => {
      if (!path) return;
      // sendMessage() resolves (never rejects) for both real failure modes —
      // a thrown fetch (companion offline) and a validation/404 response are
      // both turned into a resolved `{ success: false, error }` by the
      // service worker's listener — so the resolved value, not just a
      // rejection, must be inspected to surface a failed open.
      void sendMessage({ action: 'openInObsidian', data: { path } })
        .then(response => {
          if (!response.success) {
            console.error('[G2O] Failed to open note in Obsidian:', response.error);
            showErrorToast(response.error);
          }
        })
        .catch(error => {
          console.error('[G2O] Failed to open note in Obsidian:', error);
          showErrorToast(extractErrorMessage(error));
        });
    },
    // Only offered on a platform with a working ArchiveAdapter —
    // ARCHIVE_SUPPORTED_PLATFORMS doesn't change for the life of this
    // content-script instance, unlike the conversation id itself. Omitted
    // (not a no-op) on any other platform, so the menu entry simply
    // doesn't appear rather than offering an action that can only fail.
    onRepair: ARCHIVE_SUPPORTED_PLATFORMS.includes(extractor.platform)
      ? handleRepairClick
      : undefined,
    // Re-checked fresh every time the menu is built (see
    // buildMenuEntries), unlike onRepair's presence above: the SPA can
    // navigate to a page with no resolvable conversation id (e.g. a
    // brand-new ChatGPT chat before its URL gains an id) without a reload,
    // so this can't be decided once here at injection time.
    canRepair: () => Boolean(getExtractor()?.getConversationId()),
  });
  // Establish the icon's context before any sync can run, so the very
  // first paint isn't dropped for having no context to match against.
  setIconContext(location.href);
  console.info('[G2O] Sync icon injected');

  // Continuous background sync: drive runAutoSync off DOM mutations on the
  // same observation root used to detect the conversation container, so an
  // idle page costs nothing between edits. Debounced (trailing-edge only,
  // no max wait) rather than throttled: a streaming response mutates the
  // DOM continuously, and a leading-edge throttle would sync the first
  // partial token as if it were the finished message.
  stopAutoSync();
  const debounced = debounce(runAutoSync, AUTO_SYNC_DEBOUNCE);
  debouncedAutoSync = debounced;
  autoSyncObserver = new MutationObserver(records => {
    // Never let our own icon repaint retrigger a sync -- see
    // isSelfInflictedMutation(). Only a NON-EMPTY batch that is entirely
    // self-inflicted is ignored: an empty batch carries no evidence of
    // where it came from, and suppressing a real mutation loses a message
    // whereas a spurious sync costs one round trip. Fail toward syncing.
    if (records.length > 0 && records.every(isSelfInflictedMutation)) return;
    debounced();
  });
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

  // Non-fatal problems reported by a destination that still succeeded — e.g.
  // images that could not be written (issue #376). Shown alongside extraction
  // warnings so a successful save never hides a partial failure.
  const saveWarnings = saveResult.results
    .map((r: OutputResult) => r.warning)
    .filter((w): w is string => Boolean(w));
  const warnings = [...saveWarnings, ...(extractionWarnings ?? [])];

  if (warnings.length > 0 && saveResult.anySuccessful) {
    setTimeout(() => {
      showWarningToast(warnings.join('. '));
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
function reportSyncOutcome(errorMessage: string | null, href: string): void {
  if (autoSyncInFlight) return;
  if (errorMessage) {
    paintFor(href, 'offline', { error: errorMessage });
    return;
  }
  const suggestionCount = getSuggestionCount();
  paintFor(href, deriveState({ configured: true, syncing: false, error: null, suggestionCount }), {
    suggestionCount,
    // A real, confirmed success — resolve any error a previous attempt
    // left behind rather than leaving it retained, and the `blocked`
    // dimension with it (see sendChatSync for why it must be explicit).
    error: null,
    blocked: null,
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
  // Captured before trySync()'s awaits (settings, extraction, save) — an
  // in-app navigation during any of those must not let this sync's outcome
  // paint onto whatever conversation is on screen when it resolves.
  const startHref = location.href;
  if (!autoSyncInFlight) paintFor(startHref, 'syncing');

  const errorMessage = await trySync();
  reportSyncOutcome(errorMessage, startHref);
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
 *
 * A rejection envelope from the worker becomes an ordinary failure, reported
 * through the same toast and sync icon as any other (issue #467): it must never
 * reach displaySaveResults(), which reads `results`. trySync() catches it.
 */
async function saveToOutputs(
  note: ObsidianNote,
  outputs: OutputDestination[]
): Promise<MultiOutputResponse> {
  const response = await sendMessage({ action: 'saveToOutputs', data: note, outputs });
  if (isMultiOutputResponse(response)) return response;
  throw new Error(describeUnexpectedResponse(response));
}
