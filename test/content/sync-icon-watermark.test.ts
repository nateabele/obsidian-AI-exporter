/**
 * Watermark invalidation of the sync icon (issues #465/#468).
 *
 * The icon is a point-in-time record: it says what the last sync covered, not
 * that the conversation is current. Without this, a message arriving after a
 * sync left `synced` painted, and a partial sync was indistinguishable from a
 * complete one. Our earlier fixes (8cc684e, d5bf5dd) both key on the
 * conversation IDENTITY changing, so neither fires when a new turn arrives
 * WITHIN the same conversation — which is exactly what this covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachWatermarkWatcher,
  injectSyncIcon,
  paintFor,
  setIconContext,
  setSyncState,
} from '../../src/content/sync-icon';
import type { SyncIconHandlers } from '../../src/content/sync-icon';

const handlers = {
  onOpenOptions: () => {},
  onRetry: () => {},
  onSyncNow: () => {},
  onOpenPath: () => {},
} satisfies SyncIconHandlers;

/** The conversation these tests sync, and the one they navigate to. */
const HREF = '/c/abc';
const OTHER_HREF = '/c/def';

/** The icon's current visual state — `data-state`, the only place it lives. */
const state = (): string | undefined => document.getElementById('g2o-sync-icon')?.dataset.state;

describe('attachWatermarkWatcher', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    injectSyncIcon(handlers);
    // The icon's retained detail (error, blocked reason, suggestions) is
    // module state shared across every test in this worker, and
    // setIconContext() is a no-op when the href already matches — so switch
    // away first, then back to the href these tests paint under, to start
    // each one from a genuinely clean context.
    setIconContext(OTHER_HREF);
    setIconContext(HREF);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('leaves synced in place while the watermark does not advance', () => {
    paintFor(HREF, 'synced');
    stop = attachWatermarkWatcher(HREF, 12, () => 12);

    vi.advanceTimersByTime(5000);

    expect(state()).toBe('synced');
  });

  it('drops synced when a strictly greater watermark appears', () => {
    paintFor(HREF, 'synced');
    let current = 12;
    stop = attachWatermarkWatcher(HREF, 12, () => current);

    current = 13;
    vi.advanceTimersByTime(5000);

    expect(state()).toBe('attention');
  });

  it('retains the growth as the blocked reason the menu explains', () => {
    paintFor(HREF, 'synced');
    let current = 12;
    stop = attachWatermarkWatcher(HREF, 12, () => current);

    current = 13;
    vi.advanceTimersByTime(5000);

    // chrome.i18n.getMessage is stubbed in test/setup.ts to return the raw
    // key, so the retained reason reads as the key rather than the English
    // copy that only renders in the real extension.
    expect(document.getElementById('g2o-sync-icon')?.title).toBe(
      'syncIcon_conversationGrewSinceSync'
    );
  });

  it('stops claiming growth once a confirmed success has answered it', () => {
    paintFor(HREF, 'synced');
    let current = 12;
    stop = attachWatermarkWatcher(HREF, 12, () => current);

    current = 13;
    vi.advanceTimersByTime(5000);
    expect(state()).toBe('attention');

    // What runAutoSync's confirmed-success paint passes (see sendChatSync).
    // This ordering is the norm, not the exception: the watcher polls every
    // 1000 ms (NEW_MESSAGE_POLL_INTERVAL) while auto-sync is debounced by
    // 4000 ms (AUTO_SYNC_DEBOUNCE), so on Claude and ChatGPT the growth fires
    // before the sync that answers it on essentially every turn. Without the
    // explicit `blocked: null` the reason outlives that sync — `setSyncState`
    // leaves an absent one alone — and the tooltip reads "new messages have
    // arrived" under a tick for the rest of the conversation.
    paintFor(HREF, 'synced', { suggestionCount: 0, error: null, blocked: null });

    expect(state()).toBe('synced');
    expect(document.getElementById('g2o-sync-icon')?.title).toBe('synced');
  });

  it('never invalidates on a platform with no ordinal', () => {
    // Gemini, Perplexity and NotebookLM return null from getMessageWatermark():
    // null is "no signal", never zero, and an icon that cleared itself for a
    // scroll would be worse than one that lingers (ADR-036).
    //
    // The reading is deliberately a real number here, not null: it is the
    // absent BASELINE that must disarm the watcher. A null reading would stop
    // the comparison on its own and leave that untested.
    paintFor(HREF, 'synced');
    stop = attachWatermarkWatcher(HREF, null, () => 7);

    vi.advanceTimersByTime(5000);

    expect(state()).toBe('synced');
  });

  it('does not paint over the conversation the user has since navigated to', () => {
    paintFor(HREF, 'synced');
    let current = 12;
    stop = attachWatermarkWatcher(HREF, 12, () => current);

    // The watcher belongs to HREF; by the time it fires the icon is showing
    // OTHER_HREF, whose state must not be clobbered by the old one's growth.
    setIconContext(OTHER_HREF);
    paintFor(OTHER_HREF, 'synced');
    current = 13;
    vi.advanceTimersByTime(5000);

    expect(state()).toBe('synced');
  });

  it('keeps an unresolved connectivity error ahead of the growth', () => {
    // deriveState ranks `error` above `blocked`: a transport that actually
    // failed is more urgent than a local "there is more to send" — so the
    // growth must not paper an unresolved failure over (see sync-icon.ts).
    setSyncState('offline', { error: 'ECONNREFUSED' });
    let current = 12;
    stop = attachWatermarkWatcher(HREF, 12, () => current);

    current = 13;
    vi.advanceTimersByTime(5000);

    expect(state()).toBe('offline');
  });
});
