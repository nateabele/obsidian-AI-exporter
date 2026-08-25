/**
 * The single state-bearing sync icon, replacing the old export button.
 *
 * The icon reflects the current sync state (`data-state`) and opens a small
 * menu on click. Suggestion entries (related transcripts/topics) are added
 * to the menu in Task 11 — this file only renders the fixed entries.
 */

import { injectStyles } from './ui';
import { getMessage } from '../lib/i18n';

export type SyncIconState = 'unconfigured' | 'offline' | 'syncing' | 'synced' | 'suggestions';

export interface SyncStateInput {
  configured: boolean;
  syncing: boolean;
  error: string | null;
  suggestionCount: number;
}

export interface SyncIconHandlers {
  onOpenOptions: () => void;
  onRetry: () => void;
  onSyncNow: () => void;
  onOpenPath: (path: string) => void;
}

const GLYPHS: Record<SyncIconState, string> = {
  unconfigured: '⚙',
  offline: '⚠',
  syncing: '↻',
  synced: '✓',
  suggestions: '◉',
};

/**
 * Derive the icon's visual state from the current sync inputs.
 *
 * Precedence is deliberate: setup (`unconfigured`) beats everything else, so
 * a user who hasn't configured the companion token is always offered setup
 * first, even if a stale error or suggestions are also present. An in-flight
 * request (`syncing`) beats a stale `error` from the previous attempt — a
 * sync already underway supersedes whatever the last one left behind. Errors
 * beat suggestions, since a broken connection is more urgent than a
 * related-note nudge. `synced` is the quiet fallback.
 */
export function deriveState(input: SyncStateInput): SyncIconState {
  if (!input.configured) return 'unconfigured';
  if (input.syncing) return 'syncing';
  if (input.error) return 'offline';
  if (input.suggestionCount > 0) return 'suggestions';
  return 'synced';
}

// Last known error/note path/suggestion count, retained so the menu can
// render "Retry" with the failure detail and "Open transcript" with
// somewhere to go, and so the badge doesn't flicker to zero on every state
// change that doesn't itself carry a suggestion count (e.g. `syncing`).
let lastError: string | null = null;
let lastNotePath: string | null = null;
let lastSuggestionCount = 0;

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

/**
 * Clear the retained error/note path/suggestion count back to their initial
 * values. Retained detail is scoped to a single conversation — an SPA
 * navigation to a different conversation must call this alongside resetting
 * whatever baseline (e.g. `previousManifest`) it accompanies, or a bail-out
 * in the new conversation will settle the icon using detail left over from
 * the old one (a stale error, or "Open transcript" pointing at the wrong
 * note). Does not touch the icon's current visual state — the next
 * `setSyncState`/`settleIcon` call derives that from the now-clean detail.
 */
export function resetIconContext(): void {
  lastError = null;
  lastNotePath = null;
  lastSuggestionCount = 0;
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

/**
 * Update the icon's visual state.
 */
export function setSyncState(
  state: SyncIconState,
  detail: { suggestionCount?: number; error?: string | null; notePath?: string } = {}
): void {
  const button = document.getElementById('g2o-sync-icon');
  if (!button) return;

  button.dataset.state = state;
  // Retain the last error across calls that don't know one way or the other
  // (e.g. a background bail-out settling to a resting state) rather than
  // clearing it — only a call that explicitly passes `error` (a real
  // failure, or `null` for a real success) should update it.
  if (detail.error !== undefined) lastError = detail.error;
  button.title = lastError ?? state;
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
 * Populate the menu's entries for the given state:
 * - `unconfigured`: only "Open settings".
 * - `offline`: the last error plus "Retry".
 * - any other configured state: "Open transcript", plus "Sync now" unless a
 *   sync is already in flight (`syncing`), in which case it's omitted so it
 *   can't be re-triggered mid-request.
 *
 * Suggestion groups (related transcripts/topics) are appended here in
 * Task 11, once `ChatSyncResponse.suggestions` is threaded through.
 */
function buildMenuEntries(
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

  if (state === 'offline') {
    const errorDetail = document.createElement('div');
    errorDetail.className = 'error-detail';
    errorDetail.textContent = lastError ?? getMessage('syncIcon_syncFailed');
    menu.appendChild(errorDetail);
    addEntry(getMessage('syncIcon_retry'), handlers.onRetry);
  }
  if (state !== 'syncing') {
    addEntry(getMessage('syncIcon_syncNow'), handlers.onSyncNow);
  }
  addEntry(getMessage('syncIcon_openTranscript'), () => handlers.onOpenPath(lastNotePath ?? ''));
  // Suggestion groups (related transcripts/topics) slot in here — Task 11.
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
