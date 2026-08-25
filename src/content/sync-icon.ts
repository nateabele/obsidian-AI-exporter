/**
 * The single state-bearing sync icon, replacing the old export button.
 *
 * The icon reflects the current sync state (`data-state`) and opens a small
 * menu on click. Suggestion entries (related transcripts/topics) are added
 * to the menu in Task 11 — this file only renders the fixed entries.
 */

import { injectStyles } from './ui';

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
 * request (`syncing`) beats a stale `error` from the previous attempt.
 * Errors beat suggestions, since a broken connection is more urgent than a
 * related-note nudge. `synced` is the quiet fallback.
 */
export function deriveState(input: SyncStateInput): SyncIconState {
  if (!input.configured) return 'unconfigured';
  if (input.syncing) return 'syncing';
  if (input.error) return 'offline';
  if (input.suggestionCount > 0) return 'suggestions';
  return 'synced';
}

// Last known error/note path, retained so the menu can render "Retry" with
// the failure detail and "Open transcript" with somewhere to go, even
// though setSyncState() only touches the DOM (it doesn't return state to
// the caller).
let lastError: string | null = null;
let lastNotePath: string | null = null;

/**
 * Create and inject the sync icon.
 */
export function injectSyncIcon(handlers: SyncIconHandlers): HTMLButtonElement {
  injectStyles();
  document.getElementById('g2o-sync-icon')?.remove();
  document.getElementById('g2o-sync-menu')?.remove();

  const button = document.createElement('button');
  button.id = 'g2o-sync-icon';
  button.dataset.state = 'unconfigured';
  button.setAttribute('aria-label', 'Obsidian sync');

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
  button.title = detail.error ?? state;
  lastError = detail.error ?? null;
  if (detail.notePath) lastNotePath = detail.notePath;

  const glyph = button.querySelector('.glyph');
  if (glyph) glyph.textContent = GLYPHS[state];

  const badge = button.querySelector('.badge') as HTMLElement | null;
  if (badge) {
    const count = detail.suggestionCount ?? 0;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }
}

/**
 * Build (or, on a second click, tear down) the menu anchored above the icon.
 * Its entries depend on the icon's current `data-state`:
 * - `unconfigured`: only "Open settings".
 * - `offline`: the last error plus "Retry".
 * - any configured state: "Sync now" and "Open transcript".
 *
 * Suggestion groups (related transcripts/topics) are appended here in
 * Task 11, once `ChatSyncResponse.suggestions` is threaded through.
 */
function toggleMenu(handlers: SyncIconHandlers): void {
  const existing = document.getElementById('g2o-sync-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const icon = document.getElementById('g2o-sync-icon');
  const state = (icon?.dataset.state ?? 'unconfigured') as SyncIconState;

  const menu = document.createElement('div');
  menu.id = 'g2o-sync-menu';

  const addEntry = (label: string, onClick: () => void): void => {
    const entry = document.createElement('button');
    entry.className = 'entry';
    entry.textContent = label;
    entry.addEventListener('click', () => {
      onClick();
      menu.remove();
    });
    menu.appendChild(entry);
  };

  if (state === 'unconfigured') {
    addEntry('Open settings', handlers.onOpenOptions);
  } else {
    if (state === 'offline') {
      const errorDetail = document.createElement('div');
      errorDetail.className = 'error-detail';
      errorDetail.textContent = lastError ?? 'Sync failed';
      menu.appendChild(errorDetail);
      addEntry('Retry', handlers.onRetry);
    }
    addEntry('Sync now', handlers.onSyncNow);
    addEntry('Open transcript', () => handlers.onOpenPath(lastNotePath ?? ''));
    // Suggestion groups (related transcripts/topics) slot in here — Task 11.
  }

  document.body.appendChild(menu);

  // Close the menu on an outside click, one tick after opening so the click
  // that opened it doesn't immediately close it again.
  setTimeout(() => {
    const closeOnOutsideClick = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node) || icon?.contains(event.target as Node)) return;
      menu.remove();
      document.removeEventListener('click', closeOnOutsideClick);
    };
    document.addEventListener('click', closeOnOutsideClick);
  }, 0);
}
