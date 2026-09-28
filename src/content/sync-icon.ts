/**
 * The single state-bearing sync icon, replacing the old export button.
 *
 * The icon reflects the current sync state (`data-state`) and opens a small
 * menu on click. Suggestion entries (related transcripts/topics) are
 * rendered after the fixed entries — see `renderSuggestionGroup()`.
 */

import { injectStyles } from './ui';
import { startNewMessageWatcher } from './message-watcher';
import type { StopWatching } from './conversation-watcher';
import { getMessage } from '../lib/i18n';
import type { ChatSyncResponse, ChatSuggestion } from '../lib/types';

export type SyncIconState =
  'unconfigured' | 'offline' | 'syncing' | 'synced' | 'suggestions' | 'disabled' | 'attention';

export interface SyncStateInput {
  configured: boolean;
  syncing: boolean;
  error: string | null;
  suggestionCount: number;
  /**
   * The current conversation's platform is deliberately excluded from
   * `autoSyncPlatforms` (a user setting), so this tick never even attempted
   * a sync. Optional — every existing caller that doesn't know about this
   * dimension simply omits it, which is treated as `false`. Ranked below
   * `suggestionCount` (below, in `deriveState()`): existing suggestions are
   * still worth surfacing even on a platform the user has opted out of
   * continuous sync for.
   */
  disabled?: boolean;
  /**
   * A fresh, specific reason THIS tick could not even attempt a real sync —
   * rotted `canExtract()`, an extraction that yielded no data, or a
   * virtualized manifest window that can't be safely diffed. Distinct from
   * `error`: `error` is a genuine connectivity/companion failure from an
   * attempt that actually reached the network, while this is a local
   * blockage the network was never involved in. Optional and falsy
   * (`undefined`/`null`) when nothing is blocking. A real `error` still
   * wins over this in `deriveState()` — an unresolved connectivity failure
   * is more urgent than a same-tick local blockage.
   */
  blocked?: string | null;
}

export interface SyncIconHandlers {
  onOpenOptions: () => void;
  onRetry: () => void;
  onSyncNow: () => void;
  onOpenPath: (path: string) => void;
  /**
   * Repair the current conversation from source (re-import authoritatively
   * via the platform's own API). Optional and omitted entirely — rather
   * than provided as a no-op — on a platform with no working
   * `ArchiveAdapter`, so the menu entry (see `buildMenuEntries`) simply
   * doesn't appear rather than offering an action that can only fail. This
   * alone doesn't account for a page with no resolvable conversation id
   * right now (see `canRepair`) — that can change without this object being
   * rebuilt, since the SPA can navigate without a reload.
   */
  onRepair?: () => void;
  /**
   * Whether `onRepair` can currently act, re-checked fresh every time the
   * menu is (re)built (see `buildMenuEntries`) rather than once when the
   * icon was injected — unlike `onRepair`'s mere presence, a resolvable
   * conversation id can come and go on the same page as the SPA navigates.
   * Defaults to `true` when omitted, so callers with nothing to check don't
   * have to supply it. Ignored when `onRepair` itself is absent.
   */
  canRepair?: () => boolean;
}

const GLYPHS: Record<SyncIconState, string> = {
  unconfigured: '⚙',
  offline: '⚠',
  syncing: '↻',
  synced: '✓',
  suggestions: '◉',
  disabled: '⏸',
  attention: '❗',
};

/**
 * Derive the icon's visual state from the current sync inputs.
 *
 * Precedence is deliberate: setup (`unconfigured`) beats everything else, so
 * a user who hasn't configured the companion token is always offered setup
 * first, even if a stale error or suggestions are also present. An in-flight
 * request (`syncing`) beats a stale `error` from the previous attempt — a
 * sync already underway supersedes whatever the last one left behind. Errors
 * beat `blocked`, since a broken connection (something actually attempted
 * and failed) is more urgent than a same-tick local blockage that never
 * reached the network. `blocked` in turn beats suggestions, since a sync
 * that couldn't even run is more actionable than a related-note nudge.
 * `disabled` sits below suggestions — an existing suggestion badge is still
 * worth showing even on a platform the user has opted out of continuous
 * sync for — and above the quiet `synced` fallback, since a deliberately
 * excluded platform must never claim the quiet-default "all good" state.
 */
export function deriveState(input: SyncStateInput): SyncIconState {
  if (!input.configured) return 'unconfigured';
  if (input.syncing) return 'syncing';
  if (input.error) return 'offline';
  if (input.blocked) return 'attention';
  if (input.suggestionCount > 0) return 'suggestions';
  if (input.disabled) return 'disabled';
  return 'synced';
}

// Last known error/note path/suggestion count, retained so the menu can
// render "Retry" with the failure detail and "Open transcript" with
// somewhere to go, and so the badge doesn't flicker to zero on every state
// change that doesn't itself carry a suggestion count (e.g. `syncing`).
let lastError: string | null = null;
let lastNotePath: string | null = null;
let lastSuggestionCount = 0;

// Retained detail: the last reason a background sync was `blocked` (see
// `SyncStateInput.blocked`) rather than a genuine connectivity `error` —
// e.g. the extractor yielded no data, or a virtualized manifest window
// couldn't be safely diffed. Kept separate from `lastError` rather than
// folded into it: the two are different failure DIMENSIONS (a local
// blockage that never reached the network vs. a real transport/companion
// failure that did), and a bail-out that only knows about one must never
// have its detail misread as the other on a later tick — see
// `deriveState()`'s precedence between `error` and `blocked`.
let lastBlockedReason: string | null = null;

// The suggested related transcripts/topics for the current conversation, as
// last reported via `setSuggestions()`. Retained detail like the rest of
// the module state above — cleared in `setIconContext()` so a stale list
// belonging to a previous conversation never renders into the menu.
let currentSuggestions: ChatSyncResponse['suggestions'] = { transcripts: [], pages: [] };

/**
 * Record the suggestions returned by the latest sync, for the menu to
 * render on next open. Does not itself repaint anything — call alongside
 * `setSyncState`/`paintFor` with the matching `suggestionCount`.
 *
 * `href` is the conversation the sync began under (the same one passed to
 * the matching `paintFor()` call) and is checked against `contextHref`
 * before writing, exactly like `paintFor()` — this is retained detail, so a
 * slow response for a conversation the user has since navigated away from
 * must not clobber the current conversation's suggestions, even though its
 * icon paint is separately (and correctly) already a no-op.
 */
export function setSuggestions(href: string, suggestions: ChatSyncResponse['suggestions']): void {
  if (href !== contextHref) return;
  currentSuggestions = suggestions;
}

/**
 * The combined count of currently-known transcript and topic suggestions,
 * i.e. what the badge should show once painted via `setSyncState`/`paintFor`.
 */
export function suggestionCount(): number {
  return currentSuggestions.transcripts.length + currentSuggestions.pages.length;
}

/**
 * The last known suggestion count, as last reported via `setSyncState`.
 * Callers that need to derive a follow-up state (e.g. after a sync
 * completes) without clobbering an existing suggestion badge should read
 * this rather than hardcoding 0.
 */
export function getSuggestionCount(): number {
  return lastSuggestionCount;
}

/**
 * The last known sync error, as last reported via `setSyncState`, or `null`
 * if the last thing that actually resolved (rather than merely bailed out
 * without checking) was a success. Callers deriving a follow-up state for a
 * path that never checked for an error itself — e.g. a background bail-out
 * — should read this rather than asserting `null`, which would silently
 * clear a real, still-unresolved error off the icon.
 */
export function getLastError(): string | null {
  return lastError;
}

// There is deliberately no `getLastBlockedReason()` counterpart to
// `getLastError()`: `setSyncState` treats an absent `blocked` as "leave the
// retained reason alone" (see `paintFor`), so a caller deriving a follow-up
// state never has to read it back to avoid clearing it. One existed and was
// never called; knip reported it as dead in the 2.14.5 merge.

// The href of the conversation the retained detail above belongs to, or
// `null` before any conversation has been established. This is the single
// mechanism a stale async result is checked against before it's allowed to
// paint (see `paintFor()`) — rather than patching each place a stale result
// could surface, every paint is conditional on this one thing.
let contextHref: string | null = null;

/**
 * Establish (or confirm) the conversation the icon's retained detail
 * belongs to. When `href` differs from the current context, the retained
 * error/note path/suggestion count/suggestion list are cleared — they
 * described the previous conversation and must not leak into the new one —
 * and every paint captured under the old href becomes a no-op via
 * `paintFor()` from this point on. A no-op when `href` already matches.
 * Does not touch the icon's current visual state — the next
 * `paintFor`/`setSyncState` call derives that from the now-clean detail.
 *
 * Call this on every conversation switch, and speculatively wherever a
 * paint could otherwise land without one having run since navigation (e.g.
 * opening the menu), so the icon is self-correcting even when no sync tick
 * has fired yet.
 */
export function setIconContext(href: string): void {
  if (href === contextHref) return;
  contextHref = href;
  lastError = null;
  lastNotePath = null;
  lastSuggestionCount = 0;
  lastBlockedReason = null;
  currentSuggestions = { transcripts: [], pages: [] };
}

// The currently-open menu and its outside-click listener, tracked in module
// scope so `closeMenu()` can always find and remove both, regardless of
// which code path (entry activation, icon re-click, outside click, Escape)
// triggered the close.
let activeMenu: HTMLElement | null = null;
let activeOutsideClickListener: ((event: MouseEvent) => void) | null = null;
let activeKeydownListener: ((event: KeyboardEvent) => void) | null = null;

function closeMenu(): void {
  if (activeOutsideClickListener) {
    document.removeEventListener('click', activeOutsideClickListener);
    activeOutsideClickListener = null;
  }
  if (activeKeydownListener) {
    document.removeEventListener('keydown', activeKeydownListener);
    activeKeydownListener = null;
  }
  activeMenu?.remove();
  activeMenu = null;
  document.getElementById('g2o-sync-icon')?.setAttribute('aria-expanded', 'false');
}

/**
 * Create and inject the sync icon.
 */
export function injectSyncIcon(handlers: SyncIconHandlers): HTMLButtonElement {
  injectStyles();
  closeMenu();
  document.getElementById('g2o-sync-icon')?.remove();

  const button = document.createElement('button');
  button.id = 'g2o-sync-icon';
  button.dataset.state = 'unconfigured';
  button.setAttribute('aria-label', getMessage('syncIcon_ariaLabel'));
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');

  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = GLYPHS.unconfigured;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;

  button.append(glyph, badge);
  button.addEventListener('click', () => toggleMenu(handlers));
  document.body.appendChild(button);
  return button;
}

export type SyncStateDetail = {
  suggestionCount?: number;
  error?: string | null;
  notePath?: string;
  blocked?: string | null;
};

/**
 * Update the icon's visual state unconditionally. Low-level primitive: it
 * has no notion of which conversation it's for, so any caller whose result
 * could be stale by the time it resolves (i.e. anything that started before
 * an `await`) must go through `paintFor()` instead, not this directly.
 */
export function setSyncState(state: SyncIconState, detail: SyncStateDetail = {}): void {
  const button = document.getElementById('g2o-sync-icon');
  if (!button) return;

  button.dataset.state = state;
  // Retain the last error across calls that don't know one way or the other
  // (e.g. a background bail-out settling to a resting state) rather than
  // clearing it — only a call that explicitly passes `error` (a real
  // failure, or `null` for a real success) should update it.
  if (detail.error !== undefined) lastError = detail.error;
  // Same retain-unless-explicit convention as `lastError` above, for the
  // separate `blocked` dimension.
  if (detail.blocked !== undefined) lastBlockedReason = detail.blocked;
  button.title = lastError ?? lastBlockedReason ?? state;
  if (detail.notePath !== undefined) lastNotePath = detail.notePath;
  if (detail.suggestionCount !== undefined) lastSuggestionCount = detail.suggestionCount;

  const glyph = button.querySelector('.glyph');
  if (glyph) glyph.textContent = GLYPHS[state];

  const badge = button.querySelector('.badge') as HTMLElement | null;
  if (badge) {
    badge.hidden = lastSuggestionCount === 0;
    badge.textContent = String(lastSuggestionCount);
  }
}

/**
 * Paint the icon, but only if `href` — the conversation the calling
 * operation began under — still matches the current context. An async
 * operation (a sync request, an extraction) can outlive an in-app
 * navigation to a different conversation; without this check, its result
 * would land on whatever conversation happens to be on screen when it
 * resolves, not the one it was actually about. Every call site that spans
 * an `await` should paint through here, never through `setSyncState`
 * directly.
 */
export function paintFor(href: string, state: SyncIconState, detail?: SyncStateDetail): void {
  if (href !== contextHref) return;
  setSyncState(state, detail);
}

/**
 * Paint the icon for "this conversation has grown past the sync it is
 * showing". Derived rather than hardcoded to `attention` so the module's own
 * precedence still holds: an unresolved connectivity `error` outranks a local
 * "there is more to send" (see `deriveState`), and a fresh growth must not
 * paper it over. `configured: true` is not an assumption — a watcher only
 * exists because a sync reached the companion.
 */
function paintConversationGrew(href: string): void {
  const reason = getMessage('syncIcon_conversationGrewSinceSync');
  paintFor(
    href,
    deriveState({
      configured: true,
      syncing: false,
      error: lastError,
      suggestionCount: lastSuggestionCount,
      blocked: reason,
    }),
    { blocked: reason }
  );
}

/**
 * Invalidate this conversation's painted state once the page grows past the
 * turn the sync covered (issues #465/#468).
 *
 * The icon is a point-in-time record of one sync, so without this a message
 * arriving afterwards leaves `synced` painted and a partial sync is
 * indistinguishable from a complete one. The signal is a conversation-wide
 * turn ordinal that is never renumbered (Claude's `data-index`, ChatGPT's
 * `conversation-turn-N`): a value strictly above the one the sync covered
 * proves a new turn, while scrolling can only ever surface ordinals at or
 * below it. A turn *count* would not do — Gemini lazy-loads OLDER messages,
 * so its count grows with nothing added (ADR-036).
 *
 * `syncedWatermark` must come from the extraction that was synced
 * (`ConversationData.messageWatermark`), never a DOM read taken after it: the
 * auto-scroll pass ends pinned at the TOP of the conversation, where the
 * newest turn is unmounted and its ordinal is gone (issue #465).
 *
 * A null `syncedWatermark` is "the platform exposes no ordinal" (Gemini,
 * Perplexity, NotebookLM) — never zero — and disarms the watcher entirely;
 * `startNewMessageWatcher` owns that guard, so there is deliberately no second
 * copy of it here. The returned stop is a no-op in that case.
 */
export function attachWatermarkWatcher(
  href: string,
  syncedWatermark: number | null,
  getWatermark: () => number | null
): StopWatching {
  return startNewMessageWatcher({
    syncedWatermark,
    getWatermark,
    onNewMessage: () => paintConversationGrew(href),
  });
}

/**
 * Append a heading and one entry per suggestion to `menu`, or nothing at
 * all when `items` is empty — a group with a heading and no entries would
 * be worse than omitting it outright.
 */
function renderSuggestionGroup(
  menu: HTMLElement,
  heading: string,
  items: ChatSuggestion[],
  onOpenPath: (path: string) => void
): void {
  if (items.length === 0) return;
  const label = document.createElement('div');
  label.className = 'group';
  label.textContent = heading;
  menu.appendChild(label);
  for (const item of items) {
    const entry = document.createElement('button');
    entry.className = 'entry';
    entry.textContent = item.title || item.path;
    entry.addEventListener('click', () => {
      onOpenPath(item.path);
      closeMenu();
    });
    menu.appendChild(entry);
  }
}

/**
 * Append a single explanatory note line to `menu` — the shared shape behind
 * `offline`'s error detail, `attention`'s blocked-reason detail, and
 * `disabled`'s fixed note below. Split out purely to keep `buildMenuEntries`
 * under the line-count lint limit.
 */
function appendMenuDetail(menu: HTMLElement, className: string, text: string): void {
  const detail = document.createElement('div');
  detail.className = className;
  detail.textContent = text;
  menu.appendChild(detail);
}

/**
 * Append the explanatory note for whichever of the three "something to
 * explain" states `state` is — a no-op for every other state. Split out of
 * `buildMenuEntries` purely to keep it under the line-count lint limit; the
 * "Retry" entry that follows `offline`'s note is NOT included here since it
 * needs `buildMenuEntries`'s own `addEntry` closure.
 */
function appendStateNote(menu: HTMLElement, state: SyncIconState): void {
  if (state === 'offline') {
    appendMenuDetail(menu, 'error-detail', lastError ?? getMessage('syncIcon_syncFailed'));
  } else if (state === 'attention') {
    appendMenuDetail(
      menu,
      'attention-detail',
      lastBlockedReason ?? getMessage('syncIcon_attentionDefault')
    );
  } else if (state === 'disabled') {
    appendMenuDetail(menu, 'note-detail', getMessage('syncIcon_autoSyncDisabled'));
  }
}

/**
 * Populate the menu's entries for the given state:
 * - `unconfigured`: only "Open settings".
 * - `offline`: the last error plus "Retry".
 * - `attention`: the retained blocked-reason (or a generic fallback) as a
 *   note, no "Retry" entry — unlike `offline`, nothing was actually sent
 *   anywhere to retry; "Sync now" below covers trying again.
 * - `disabled`: a fixed note explaining auto-sync is off for this platform.
 * - any other configured state: "Open transcript", plus "Sync now" and
 *   "Repair this conversation from source" (the latter only when
 *   `handlers.onRepair` is provided and `handlers.canRepair` — re-checked
 *   here, fresh, every time the menu is built — doesn't say otherwise)
 *   unless a sync is already in flight (`syncing`), in which case both are
 *   omitted so neither can be re-triggered mid-request. `attention` and
 *   `disabled` both fall through to this shared block too — neither
 *   prevents a manual sync, so both still offer it.
 *
 * Suggestion groups (related transcripts, then related topics) follow the
 * fixed entries, one heading plus one entry per item, each group omitted
 * entirely when its list is empty.
 */
export function buildMenuEntries(
  menu: HTMLElement,
  state: SyncIconState,
  handlers: SyncIconHandlers
): void {
  const addEntry = (label: string, onClick: () => void): void => {
    const entry = document.createElement('button');
    entry.className = 'entry';
    entry.textContent = label;
    entry.addEventListener('click', () => {
      onClick();
      closeMenu();
    });
    menu.appendChild(entry);
  };

  if (state === 'unconfigured') {
    addEntry(getMessage('syncIcon_openSettings'), handlers.onOpenOptions);
    return;
  }

  appendStateNote(menu, state);
  if (state === 'offline') {
    addEntry(getMessage('syncIcon_retry'), handlers.onRetry);
  }
  if (state !== 'syncing') {
    addEntry(getMessage('syncIcon_syncNow'), handlers.onSyncNow);
  }
  addEntry(getMessage('syncIcon_openTranscript'), () => handlers.onOpenPath(lastNotePath ?? ''));
  // Omitted while a sync is already in flight, same as "Sync now" above —
  // a repair started mid-sync would race it on the icon's paint state.
  // canRepair() is consulted fresh here (not cached from injectSyncIcon
  // time) because whether the current page has a resolvable conversation
  // id can change between menu opens as the SPA navigates.
  if (state !== 'syncing' && handlers.onRepair && (handlers.canRepair?.() ?? true)) {
    addEntry(getMessage('syncIcon_repair'), handlers.onRepair);
  }
  renderSuggestionGroup(
    menu,
    getMessage('syncIcon_relatedConversations'),
    currentSuggestions.transcripts,
    handlers.onOpenPath
  );
  renderSuggestionGroup(
    menu,
    getMessage('syncIcon_relatedTopics'),
    currentSuggestions.pages,
    handlers.onOpenPath
  );
}

/**
 * Wire up the two ways a menu can be closed without an explicit entry
 * click: Escape, and a click outside both the menu and the icon. Both
 * listeners are tracked in module scope so `closeMenu()` can always detach
 * them, regardless of which path actually triggers the close.
 *
 * Registered synchronously, not deferred — the click that opened the menu
 * (on the icon) is still bubbling when this runs, and `closeOnOutsideClick`
 * already returns early for it via `icon?.contains(event.target)`, so a
 * `setTimeout` isn't needed to dodge it. A deferred registration was a race:
 * a close-then-reopen inside the same tick could leave a stale timer that
 * fires later and clobbers `activeOutsideClickListener` with a listener for
 * an already-removed menu, orphaning the real one so `closeMenu()` could
 * never reach it.
 */
function attachMenuCloseListeners(menu: HTMLElement, icon: HTMLElement | null): void {
  const closeOnKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeMenu();
  };
  activeKeydownListener = closeOnKeydown;
  document.addEventListener('keydown', closeOnKeydown);

  const closeOnOutsideClick = (event: MouseEvent): void => {
    if (menu.contains(event.target as Node) || icon?.contains(event.target as Node)) return;
    closeMenu();
  };
  activeOutsideClickListener = closeOnOutsideClick;
  document.addEventListener('click', closeOnOutsideClick);
}

/**
 * Build (or, on a second click, tear down) the menu anchored above the icon.
 */
function toggleMenu(handlers: SyncIconHandlers): void {
  // Self-correcting even when no sync tick has run since navigation: the
  // only other reset path (inside runAutoSync) sits behind a multi-second
  // debounce, so without this the menu could show a previous conversation's
  // error or "Open transcript" target for that entire window.
  setIconContext(location.href);

  if (activeMenu) {
    closeMenu();
    return;
  }

  const icon = document.getElementById('g2o-sync-icon');
  const state = (icon?.dataset.state ?? 'unconfigured') as SyncIconState;

  const menu = document.createElement('div');
  menu.id = 'g2o-sync-menu';
  buildMenuEntries(menu, state, handlers);

  document.body.appendChild(menu);
  activeMenu = menu;
  icon?.setAttribute('aria-expanded', 'true');
  attachMenuCloseListeners(menu, icon);
}
