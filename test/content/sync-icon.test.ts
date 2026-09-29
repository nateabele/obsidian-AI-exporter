import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deriveState,
  injectSyncIcon,
  setSyncState,
  paintFor,
  getLastError,
  getSuggestionCount,
  setIconContext,
  setSuggestions,
  suggestionCount,
  buildMenuEntries,
  recordSyncAttempt,
  getLastAttempt,
} from '../../src/content/sync-icon';
import type { SyncIconHandlers, SyncAttemptOutcome } from '../../src/content/sync-icon';
import { setClaudeLocation, resetLocation } from '../fixtures/dom-helpers';

// `contextHref` is module-level state, shared across every test in this
// file (and every other file that imports the real module in the same
// worker), and `toggleMenu` reads the live `location.href` global directly
// — not a value the test controls. Establish (or reconfirm) the context to
// match the current `location.href` before every test, mirroring what
// `initialize()` does in production before any sync can run, so a test's
// pass/fail doesn't depend on what a previous test happened to leave
// `contextHref` set to.
beforeEach(() => {
  setIconContext(location.href);
});

describe('deriveState', () => {
  it('is unconfigured when no companion token is set', () => {
    expect(
      deriveState({ configured: false, syncing: false, error: null, suggestionCount: 0 })
    ).toBe('unconfigured');
  });

  it('is unconfigured even while an error is present, so setup is offered first', () => {
    expect(
      deriveState({ configured: false, syncing: false, error: 'boom', suggestionCount: 3 })
    ).toBe('unconfigured');
  });

  it('is syncing while a request is in flight', () => {
    expect(deriveState({ configured: true, syncing: true, error: null, suggestionCount: 2 })).toBe(
      'syncing'
    );
  });

  it('is offline when the last sync errored', () => {
    expect(
      deriveState({ configured: true, syncing: false, error: 'ECONNREFUSED', suggestionCount: 4 })
    ).toBe('offline');
  });

  it('is suggestions when there are any to show', () => {
    expect(deriveState({ configured: true, syncing: false, error: null, suggestionCount: 4 })).toBe(
      'suggestions'
    );
  });

  it('is synced when configured, quiet, and with nothing to suggest', () => {
    expect(deriveState({ configured: true, syncing: false, error: null, suggestionCount: 0 })).toBe(
      'synced'
    );
  });

  it('is syncing even when a stale error from the previous attempt is still present', () => {
    expect(
      deriveState({ configured: true, syncing: true, error: 'ECONNREFUSED', suggestionCount: 0 })
    ).toBe('syncing');
  });
});

function makeHandlers(overrides: Partial<SyncIconHandlers> = {}): SyncIconHandlers {
  return {
    onOpenOptions: vi.fn(),
    onRetry: vi.fn(),
    onSyncNow: vi.fn(),
    onOpenPath: vi.fn(),
    onSyncAndOpenTranscript: vi.fn(),
    onRepair: vi.fn(),
    ...overrides,
  };
}

describe('injectSyncIcon', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('creates an icon with correct id', () => {
    const button = injectSyncIcon(makeHandlers());

    expect(button.id).toBe('g2o-sync-icon');
    expect(document.getElementById('g2o-sync-icon')).toBe(button);
  });

  it('injects styles into document head', async () => {
    // Reset modules to clear ui.ts's module-level styleInjected flag, since
    // an earlier test in this file may have already injected it once.
    vi.resetModules();
    const { injectSyncIcon: freshInjectSyncIcon } = await import('../../src/content/sync-icon');

    document.body.innerHTML = '';
    document.head.innerHTML = '';

    freshInjectSyncIcon(makeHandlers());

    const styleElement = document.getElementById('g2o-styles');
    expect(styleElement).not.toBeNull();
    expect(styleElement?.tagName).toBe('STYLE');
  });

  it('only injects styles once', async () => {
    vi.resetModules();
    const { injectSyncIcon: freshInjectSyncIcon } = await import('../../src/content/sync-icon');

    document.body.innerHTML = '';
    document.head.innerHTML = '';

    freshInjectSyncIcon(makeHandlers());
    freshInjectSyncIcon(makeHandlers());
    freshInjectSyncIcon(makeHandlers());

    expect(document.querySelectorAll('#g2o-styles').length).toBe(1);
  });

  it('icon is appended to document body', () => {
    injectSyncIcon(makeHandlers());

    expect(document.body.querySelector('#g2o-sync-icon')).not.toBeNull();
  });

  it('icon contains glyph and badge spans', () => {
    injectSyncIcon(makeHandlers());

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.querySelector('.glyph')).not.toBeNull();
    expect(button?.querySelector('.badge')).not.toBeNull();
  });

  it('starts in the unconfigured state', () => {
    injectSyncIcon(makeHandlers());

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.dataset.state).toBe('unconfigured');
  });

  it('removes an existing icon before creating a new one', () => {
    const handlers1 = makeHandlers();
    const handlers2 = makeHandlers();

    injectSyncIcon(handlers1);
    injectSyncIcon(handlers2);

    expect(document.querySelectorAll('#g2o-sync-icon').length).toBe(1);

    // The new icon uses the new handlers: an unconfigured click opens
    // "Open settings" wired to handlers2, not handlers1.
    document.getElementById('g2o-sync-icon')?.click();
    document.querySelector('#g2o-sync-menu .entry')?.dispatchEvent(new Event('click'));

    expect(handlers1.onOpenOptions).not.toHaveBeenCalled();
    expect(handlers2.onOpenOptions).toHaveBeenCalledTimes(1);
  });

  it('opens the menu when clicked, and closes it on a second click', () => {
    injectSyncIcon(makeHandlers());

    const button = document.getElementById('g2o-sync-icon');
    button?.click();
    expect(document.getElementById('g2o-sync-menu')).not.toBeNull();

    button?.click();
    expect(document.getElementById('g2o-sync-menu')).toBeNull();
  });
});

describe('setSyncState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    injectSyncIcon(makeHandlers());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('updates data-state', () => {
    setSyncState('syncing');

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.dataset.state).toBe('syncing');
  });

  it('reverts to a quiet state afterwards', () => {
    setSyncState('syncing');
    setSyncState('synced');

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.dataset.state).toBe('synced');
  });

  it('shows the suggestion badge with a count', () => {
    setSyncState('suggestions', { suggestionCount: 3 });

    const badge = document.getElementById('g2o-sync-icon')?.querySelector('.badge') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3');
  });

  it('hides the suggestion badge when the count is zero', () => {
    setSyncState('suggestions', { suggestionCount: 3 });
    setSyncState('synced', { suggestionCount: 0 });

    const badge = document.getElementById('g2o-sync-icon')?.querySelector('.badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it('does nothing when the icon does not exist', () => {
    document.body.innerHTML = '';

    expect(() => setSyncState('syncing')).not.toThrow();
    expect(() => setSyncState('synced')).not.toThrow();
  });

  it('retains the last error across calls that omit it', () => {
    try {
      setSyncState('offline', { error: 'network blip' });
      // A later call that doesn't know whether the last attempt failed
      // (e.g. a background bail-out settling to a resting state) must not
      // clobber the retained error just by omitting it.
      setSyncState('offline');

      expect(getLastError()).toBe('network blip');
    } finally {
      // lastError is module-level state, shared across every test in this
      // file — restore it so a later test asserting on a clean/no-error
      // state doesn't inherit this one's error.
      setSyncState('synced', { error: null });
    }
  });

  it('clears the retained error only when a call explicitly passes null', () => {
    setSyncState('offline', { error: 'network blip' });
    setSyncState('synced', { error: null });

    expect(getLastError()).toBeNull();
  });

  it('retains the last blocked reason across calls that omit it', () => {
    try {
      setSyncState('attention', { blocked: 'Extraction failed' });
      // Same retain-unless-explicit convention as the error above, for the
      // separate `blocked` dimension. There is deliberately no
      // getLastBlockedReason() to read it back with, so assert through the
      // tooltip, which falls back to the retained reason when no error is
      // retained.
      setSyncState('attention');

      expect(document.getElementById('g2o-sync-icon')?.title).toBe('Extraction failed');
    } finally {
      // lastBlockedReason is module-level state shared across every test in
      // this file — restore it, exactly as the error case above does.
      setSyncState('synced', { blocked: null });
    }
  });

  it('clears the retained blocked reason only when a call explicitly passes null', () => {
    setSyncState('attention', { blocked: 'Extraction failed' });
    setSyncState('synced', { blocked: null });

    // With neither an error nor a reason retained, the tooltip degrades to the
    // state name.
    expect(document.getElementById('g2o-sync-icon')?.title).toBe('synced');
  });

  it('shows a retained error ahead of a retained blocked reason', () => {
    try {
      setSyncState('attention', { blocked: 'Extraction failed' });
      setSyncState('offline', { error: 'ECONNREFUSED' });

      // Two different failure dimensions, both retained; a connectivity
      // failure that actually happened is the more urgent of the two.
      expect(document.getElementById('g2o-sync-icon')?.title).toBe('ECONNREFUSED');
    } finally {
      setSyncState('synced', { error: null, blocked: null });
    }
  });
});

describe('setIconContext', () => {
  const hrefA = 'https://claude.ai/chat/conversation-a';
  const hrefB = 'https://claude.ai/chat/conversation-b';

  beforeEach(() => {
    document.body.innerHTML = '';
    injectSyncIcon(makeHandlers());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clears the retained error, note path, and suggestion count when the href changes', () => {
    setIconContext(hrefA);
    paintFor(hrefA, 'offline', {
      error: 'network blip',
      notePath: 'AI/claude/conversation-a.md',
      suggestionCount: 3,
    });

    setIconContext(hrefB);

    expect(getLastError()).toBeNull();
    expect(getSuggestionCount()).toBe(0);

    // No dedicated getter for the note path (see setSyncState's
    // `onOpenPath` handler) — assert via the menu entry's behaviour
    // instead, same as the pre-existing "Open transcript" coverage below.
    // injectSyncIcon() resets visual state to 'unconfigured', so the new
    // icon needs a state that offers "Open transcript" again.
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setIconContext(hrefB);
    paintFor(hrefB, 'synced');
    document.getElementById('g2o-sync-icon')?.click();
    const openTranscript = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).find(
      e => e.textContent === 'syncIcon_openTranscript'
    );
    openTranscript?.dispatchEvent(new Event('click'));

    // With no path retained for THIS conversation, the entry syncs to find
    // one (onSyncAndOpenTranscript) rather than opening anything — and in
    // particular never the previous conversation's note.
    expect(handlers.onSyncAndOpenTranscript).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPath).not.toHaveBeenCalled();
  });

  it('clears the retained blocked reason when the href changes', () => {
    setIconContext(hrefA);
    paintFor(hrefA, 'attention', { blocked: 'Extraction failed' });

    setIconContext(hrefB);
    // Nothing re-derives the visual state here, so re-paint under the new
    // href: with no reason retained, the menu must fall back to the generic
    // note rather than repeating the previous conversation's.
    paintFor(hrefB, 'attention');
    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelector('#g2o-sync-menu .attention-detail')?.textContent).toBe(
      'syncIcon_attentionDefault'
    );
  });

  it('is a no-op when the href has not changed, so retained detail is preserved', () => {
    setIconContext(hrefA);
    paintFor(hrefA, 'offline', { error: 'network blip' });

    setIconContext(hrefA);

    expect(getLastError()).toBe('network blip');
  });

  it("does not itself change the icon's current visual state", () => {
    setIconContext(hrefA);
    paintFor(hrefA, 'offline', { error: 'network blip' });

    setIconContext(hrefB);

    const button = document.getElementById('g2o-sync-icon');
    // Retained detail is cleared, but nothing re-derives the visual state
    // here — that's the caller's job via the next paintFor/settleIcon.
    expect(button?.dataset.state).toBe('offline');
  });
});

describe('paintFor', () => {
  const hrefA = 'https://claude.ai/chat/conversation-a';
  const hrefB = 'https://claude.ai/chat/conversation-b';

  beforeEach(() => {
    document.body.innerHTML = '';
    injectSyncIcon(makeHandlers());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('paints when the href matches the current context', () => {
    setIconContext(hrefA);

    paintFor(hrefA, 'offline', { error: 'network blip' });

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.dataset.state).toBe('offline');
    expect(getLastError()).toBe('network blip');
  });

  it('drops a paint captured under a conversation the context has since moved past', () => {
    // A sync starts under conversation A...
    setIconContext(hrefA);
    setSyncState('synced');

    // ...but the SPA navigates to conversation B before it resolves.
    setIconContext(hrefB);

    // A's late-arriving result must not land on B.
    paintFor(hrefA, 'offline', { error: 'A failed' });

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.dataset.state).toBe('synced');
    expect(getLastError()).toBeNull();
  });
});

describe('the icon menu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('offers only "Open settings" while unconfigured', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);

    document.getElementById('g2o-sync-icon')?.click();

    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).map(
      e => e.textContent
    );
    // chrome.i18n.getMessage is stubbed in test/setup.ts to return the raw
    // key, so entries assert against the i18n keys rather than the English
    // copy that only renders in the real extension.
    expect(entries).toEqual(['syncIcon_openSettings']);

    document.querySelector('#g2o-sync-menu .entry')?.dispatchEvent(new Event('click'));
    expect(handlers.onOpenOptions).toHaveBeenCalledTimes(1);
  });

  it('offers the error detail and "Retry" while offline', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('offline', { error: 'ECONNREFUSED' });

    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelector('#g2o-sync-menu .error-detail')?.textContent).toBe(
      'ECONNREFUSED'
    );
    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).map(
      e => e.textContent
    );
    expect(entries).toEqual([
      'syncIcon_retry',
      'syncIcon_syncNow',
      'syncIcon_openTranscript',
      'syncIcon_repair',
    ]);
  });

  it('explains the retained blocked reason while attention, without offering "Retry"', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('attention', { blocked: 'syncIcon_conversationGrewSinceSync' });

    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelector('#g2o-sync-menu .attention-detail')?.textContent).toBe(
      'syncIcon_conversationGrewSinceSync'
    );
    // No "Retry": unlike `offline`, nothing was actually sent anywhere, so
    // "Sync now" is the entry that acts on this.
    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).map(
      e => e.textContent
    );
    expect(entries).toEqual(['syncIcon_syncNow', 'syncIcon_openTranscript', 'syncIcon_repair']);
  });

  it('falls back to a generic message when no error detail is known', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    // Explicit `error: null`, not an omitted `error`: lastError is now
    // retained across calls that don't pass one, so this test must not
    // rely on module state left clean by execution order — it's testing
    // the fallback copy for a genuinely-resolved error, not "whatever the
    // previous test happened to leave behind."
    setSyncState('offline', { error: null });

    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelector('#g2o-sync-menu .error-detail')?.textContent).toBe(
      'syncIcon_syncFailed'
    );
  });

  it('offers "Sync now" and "Open transcript" once synced', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('synced', { notePath: 'AI/gemini/hello.md' });

    document.getElementById('g2o-sync-icon')?.click();

    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry'));
    expect(entries.map(e => e.textContent)).toEqual([
      'syncIcon_syncNow',
      'syncIcon_openTranscript',
      'syncIcon_repair',
    ]);

    entries[1].dispatchEvent(new Event('click'));
    expect(handlers.onOpenPath).toHaveBeenCalledWith('AI/gemini/hello.md');
  });

  it('omits "Sync now" while a sync is already in flight', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('syncing');

    document.getElementById('g2o-sync-icon')?.click();

    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).map(
      e => e.textContent
    );
    expect(entries).toEqual(['syncIcon_openTranscript']);
  });

  it('shows no stale error or transcript path when opened immediately after navigating, before any sync tick has run', () => {
    // Regression pin for the round-5 audit: the only other reset path
    // (inside runAutoSync) sits behind a multi-second debounce. Establish
    // detail under a stale conversation the context has since moved past,
    // then open the menu without any tick running in between — toggleMenu's
    // own `setIconContext(location.href)` call must self-correct before the
    // menu renders, not leave the previous conversation's error/path
    // showing for that whole debounce window.
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setIconContext('https://claude.ai/chat/stale-conversation');
    setSyncState('offline', { error: 'ECONNREFUSED', notePath: 'AI/claude/stale.md' });

    // The click's own handler calls toggleMenu, which reads the real
    // (different) jsdom location.href and self-corrects the context before
    // building the menu — no explicit navigation helper needed here.
    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelector('#g2o-sync-menu .error-detail')?.textContent).toBe(
      'syncIcon_syncFailed'
    );
    // "Open transcript" is second-to-last: "Repair this conversation from
    // source" (from the default makeHandlers()) follows it. The stale path
    // was cleared with the rest of the detail, so the entry syncs for a
    // fresh one instead of opening the previous conversation's note — and
    // never passes the empty path that used to make it do nothing at all.
    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry'));
    entries[entries.length - 2].dispatchEvent(new Event('click'));
    expect(handlers.onSyncAndOpenTranscript).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPath).not.toHaveBeenCalled();
  });
});

// Drives buildMenuEntries() directly rather than through injectSyncIcon +
// click, so a state that has no corresponding icon `data-state` fixture
// (there isn't one here, but this keeps the repair-specific cases isolated
// from the fixed-entry assertions above) can be exercised without
// perturbing them.
describe('the repair menu entry', () => {
  let menu: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    menu = document.createElement('div');
    document.body.appendChild(menu);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const entries = () => Array.from(menu.querySelectorAll('.entry')).map(e => e.textContent);

  it('offers repair for a configured, idle state', () => {
    buildMenuEntries(menu, 'synced', makeHandlers());
    expect(entries()).toContain('syncIcon_repair');
  });

  it('does not offer repair while a sync is in flight', () => {
    buildMenuEntries(menu, 'syncing', makeHandlers());
    expect(entries()).not.toContain('syncIcon_repair');
  });

  it('does not offer repair when unconfigured', () => {
    buildMenuEntries(menu, 'unconfigured', makeHandlers());
    expect(entries()).not.toContain('syncIcon_repair');
  });

  it('does not offer repair when no handler is provided, e.g. an unsupported platform', () => {
    buildMenuEntries(menu, 'synced', makeHandlers({ onRepair: undefined }));
    expect(entries()).not.toContain('syncIcon_repair');
  });

  it('does not offer repair when canRepair reports false, e.g. no resolvable conversation id right now', () => {
    buildMenuEntries(menu, 'synced', makeHandlers({ canRepair: () => false }));
    expect(entries()).not.toContain('syncIcon_repair');
  });

  it('offers repair when canRepair reports true', () => {
    buildMenuEntries(menu, 'synced', makeHandlers({ canRepair: () => true }));
    expect(entries()).toContain('syncIcon_repair');
  });

  it('re-checks canRepair fresh on every build rather than caching its first result', () => {
    let resolvable = false;
    const handlers = makeHandlers({ canRepair: () => resolvable });

    buildMenuEntries(menu, 'synced', handlers);
    expect(entries()).not.toContain('syncIcon_repair');

    resolvable = true;
    buildMenuEntries(menu, 'synced', handlers);
    expect(entries()).toContain('syncIcon_repair');
  });

  it('calls onRepair when clicked', () => {
    const handlers = makeHandlers();
    buildMenuEntries(menu, 'synced', handlers);
    const btn = Array.from(menu.querySelectorAll<HTMLButtonElement>('.entry')).find(
      e => e.textContent === 'syncIcon_repair'
    )!;
    btn.click();
    expect(handlers.onRepair).toHaveBeenCalled();
  });
});

describe('menu close paths', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('removes the outside-click listener when the menu is closed by an entry', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('synced');

    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    document.getElementById('g2o-sync-icon')?.click();

    const clickAdds = addSpy.mock.calls.filter(([type]) => type === 'click').length;
    expect(clickAdds).toBe(1);

    document.querySelector('#g2o-sync-menu .entry')?.dispatchEvent(new Event('click'));

    const clickRemoves = removeSpy.mock.calls.filter(([type]) => type === 'click').length;
    expect(clickRemoves).toBe(1);
    expect(document.getElementById('g2o-sync-menu')).toBeNull();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('removes the outside-click listener when the icon is clicked again', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('synced');

    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const button = document.getElementById('g2o-sync-icon');
    button?.click();
    button?.click();

    const clickRemoves = removeSpy.mock.calls.filter(([type]) => type === 'click').length;
    expect(clickRemoves).toBe(1);
    expect(document.getElementById('g2o-sync-menu')).toBeNull();

    removeSpy.mockRestore();
  });

  it('removes the outside-click listener on a genuine outside click', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('synced');

    document.getElementById('g2o-sync-icon')?.click();

    const removeSpy = vi.spyOn(document, 'removeEventListener');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clickRemoves = removeSpy.mock.calls.filter(([type]) => type === 'click').length;
    expect(clickRemoves).toBe(1);
    expect(document.getElementById('g2o-sync-menu')).toBeNull();

    removeSpy.mockRestore();
  });

  it('does not leak a listener across repeated open/close cycles', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('synced');

    const button = document.getElementById('g2o-sync-icon');
    for (let i = 0; i < 5; i++) {
      button?.click();
      document.querySelector('#g2o-sync-menu .entry')?.dispatchEvent(new Event('click'));
    }

    // A leaked listener from an earlier cycle would still be attached and
    // would remove the (already-removed) menu again without error, but a
    // genuine outside click afterwards should only ever find zero or one
    // listener doing real work — assert indirectly via removeEventListener
    // call count staying in lockstep with addEventListener's.
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    button?.click();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clickAdds = addSpy.mock.calls.filter(([type]) => type === 'click').length;
    const clickRemoves = removeSpy.mock.calls.filter(([type]) => type === 'click').length;
    expect(clickRemoves).toBe(clickAdds);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('closes the menu on Escape', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('synced');

    document.getElementById('g2o-sync-icon')?.click();
    expect(document.getElementById('g2o-sync-menu')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('g2o-sync-menu')).toBeNull();
  });

  it('reaches the current menu with an outside click after a same-tick close-then-reopen', () => {
    // Regression pin: a deferred (setTimeout) registration meant a
    // close-then-reopen inside the same tick could leave a stale timer that
    // fired later and clobbered the tracked listener with one for an
    // already-removed menu, orphaning the listener for the menu that's
    // actually on screen. Registration is now synchronous, so this can't
    // happen — a genuine outside click must always close the current menu.
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('synced');

    const button = document.getElementById('g2o-sync-icon');
    button?.click(); // open
    button?.click(); // close, same tick
    button?.click(); // reopen, same tick
    expect(document.getElementById('g2o-sync-menu')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('g2o-sync-menu')).toBeNull();
  });
});

describe('accessibility attributes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes aria-haspopup and toggles aria-expanded with the menu', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('synced');

    const button = document.getElementById('g2o-sync-icon');
    expect(button?.getAttribute('aria-haspopup')).toBe('menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('true');

    button?.click();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('setSuggestions', () => {
  const handlers = {
    onOpenOptions: () => {},
    onRetry: () => {},
    onSyncNow: () => {},
    onOpenPath: () => {},
  };

  it('shows the combined count on the badge', () => {
    document.body.innerHTML = '';
    injectSyncIcon(handlers);
    setSuggestions(location.href, {
      transcripts: [{ kind: 'transcript', title: 'A', path: 'a.md' }],
      pages: [{ kind: 'topic', title: 'B', path: 'b.md' }],
    });
    setSyncState('suggestions', { suggestionCount: 2 });
    const badge = document.querySelector('#g2o-sync-icon .badge') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2');
  });

  it('hides the badge when there are no suggestions', () => {
    document.body.innerHTML = '';
    injectSyncIcon(handlers);
    setSuggestions(location.href, { transcripts: [], pages: [] });
    setSyncState('synced', { suggestionCount: 0 });
    const badge = document.querySelector('#g2o-sync-icon .badge') as HTMLElement;
    expect(badge.hidden).toBe(true);
  });

  it('does not apply an update for a conversation the context has since left', () => {
    document.body.innerHTML = '';
    injectSyncIcon(handlers);
    const staleHref = location.href;
    setIconContext('https://claude.ai/chat/elsewhere');

    setSuggestions(staleHref, {
      transcripts: [{ kind: 'transcript', title: 'A', path: 'a.md' }],
      pages: [],
    });

    expect(suggestionCount()).toBe(0);
  });
});

describe('suggestion groups in the menu', () => {
  // toggleMenu self-corrects the context to the real `location.href` on
  // every open (see the "shows no stale error..." regression pin above), so
  // these tests drive the actual jsdom location via setClaudeLocation()
  // rather than an arbitrary string — a mismatch would otherwise reset the
  // very state each test just established, right before the click that
  // reads it.
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    resetLocation();
  });

  it('renders a heading and one entry per item, transcripts and topics as separate groups', () => {
    setClaudeLocation('conversation-a');
    const handlers = {
      onOpenOptions: () => {},
      onRetry: () => {},
      onSyncNow: () => {},
      onOpenPath: vi.fn(),
    };
    injectSyncIcon(handlers);
    setIconContext(location.href);
    setSuggestions(location.href, {
      transcripts: [{ kind: 'transcript', title: 'A related chat', path: 'a.md' }],
      pages: [{ kind: 'topic', title: 'A related topic', path: 'b.md' }],
    });
    paintFor(location.href, 'suggestions', { suggestionCount: 2 });

    document.getElementById('g2o-sync-icon')?.click();

    const groups = Array.from(document.querySelectorAll('#g2o-sync-menu .group')).map(
      g => g.textContent
    );
    expect(groups).toEqual(['syncIcon_relatedConversations', 'syncIcon_relatedTopics']);

    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).map(
      e => e.textContent
    );
    // The fixed entries ("Sync now", "Open transcript") precede the two
    // suggestion entries.
    expect(entries.slice(-2)).toEqual(['A related chat', 'A related topic']);

    const transcriptEntry = Array.from(document.querySelectorAll('#g2o-sync-menu .entry')).find(
      e => e.textContent === 'A related chat'
    );
    transcriptEntry?.dispatchEvent(new Event('click'));
    expect(handlers.onOpenPath).toHaveBeenCalledWith('a.md');
    // Selecting an entry closes the menu, same as the fixed entries.
    expect(document.getElementById('g2o-sync-menu')).toBeNull();
  });

  it('omits a group entirely when its list is empty', () => {
    setClaudeLocation('conversation-a');
    const handlers = {
      onOpenOptions: () => {},
      onRetry: () => {},
      onSyncNow: () => {},
      onOpenPath: () => {},
    };
    injectSyncIcon(handlers);
    setIconContext(location.href);
    setSuggestions(location.href, {
      transcripts: [{ kind: 'transcript', title: 'A related chat', path: 'a.md' }],
      pages: [],
    });
    paintFor(location.href, 'suggestions', { suggestionCount: 1 });

    document.getElementById('g2o-sync-icon')?.click();

    const groups = Array.from(document.querySelectorAll('#g2o-sync-menu .group')).map(
      g => g.textContent
    );
    expect(groups).toEqual(['syncIcon_relatedConversations']);
  });

  it('shows no groups when there are no suggestions', () => {
    setClaudeLocation('conversation-a');
    injectSyncIcon({
      onOpenOptions: () => {},
      onRetry: () => {},
      onSyncNow: () => {},
      onOpenPath: () => {},
    });
    setIconContext(location.href);
    setSuggestions(location.href, { transcripts: [], pages: [] });
    paintFor(location.href, 'synced');

    document.getElementById('g2o-sync-icon')?.click();

    expect(document.querySelectorAll('#g2o-sync-menu .group')).toHaveLength(0);
  });

  it('drops a suggestions update that arrives after the context has already moved on', () => {
    // This pins the actual bug: setSuggestions() for conversation A resolves
    // (e.g. a slow chatSync response) *after* the context has already moved
    // to B — not merely being called before a later setIconContext(), which
    // would pass even without the href guard in setSuggestions().
    setClaudeLocation('conversation-a');
    const handlers = {
      onOpenOptions: () => {},
      onRetry: () => {},
      onSyncNow: () => {},
      onOpenPath: () => {},
    };
    injectSyncIcon(handlers);
    setIconContext(location.href);
    const hrefA = location.href;

    // The SPA navigates to conversation B before A's sync resolves.
    setClaudeLocation('conversation-b');
    setIconContext(location.href);
    paintFor(location.href, 'synced');

    // A's response finally arrives, captured under the href it started
    // under — not the current one.
    setSuggestions(hrefA, {
      transcripts: [{ kind: 'transcript', title: 'A related chat', path: 'a.md' }],
      pages: [],
    });

    document.getElementById('g2o-sync-icon')?.click();

    // Conversation A's suggestion must not leak into B's menu.
    expect(document.querySelectorAll('#g2o-sync-menu .group')).toHaveLength(0);
    expect(document.querySelector('#g2o-sync-menu .entry')?.textContent).not.toBe('A related chat');
  });
});

// Drives buildMenuEntries() directly, like the repair-entry block above.
//
// `lastAttempt` is module state and setIconContext() is a no-op for an
// unchanged href, so each test here brackets itself with a real context
// switch: without that, a record written by one test would still be in the
// menu of the next one (and its `.error-detail` line would shadow the state
// note every other test in this file asserts against).
describe('the last-attempt note in the menu', () => {
  let menu: HTMLElement;

  function dropAttempt(): void {
    setIconContext('https://claude.ai/chat/attempt-note-bracket');
    setIconContext(location.href);
  }

  /**
   * Make the i18n stub interpolate instead of returning the bare key, so the
   * substitutions the note is built from (time, outcome, trigger, counts) are
   * actually asserted rather than swallowed.
   */
  function interpolateMessages(): void {
    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string, subs?: string | string[]) =>
      subs === undefined ? key : `${key}(${(Array.isArray(subs) ? subs : [subs]).join('|')})`
    );
  }

  const notes = (): (string | null)[] =>
    Array.from(menu.querySelectorAll('.note-detail, .error-detail, .attention-detail')).map(
      e => e.textContent
    );

  beforeEach(() => {
    dropAttempt();
    document.body.innerHTML = '';
    menu = document.createElement('div');
    document.body.appendChild(menu);
  });

  afterEach(() => {
    dropAttempt();
    document.body.innerHTML = '';
    vi.mocked(chrome.i18n.getMessage).mockImplementation((key: string) => key);
  });

  it('shows nothing before anything has been attempted for this conversation', () => {
    buildMenuEntries(menu, 'synced', makeHandlers());

    expect(notes()).toEqual([]);
  });

  it('says when the attempt resolved, how it ended, and what started it', () => {
    interpolateMessages();
    recordSyncAttempt(location.href, { trigger: 'mutation', outcome: 'sent', sent: 2 });

    buildMenuEntries(menu, 'synced', makeHandlers());

    // The timestamp is read back off the record rather than hardcoded: the
    // assertion is that the note renders THIS attempt's time in the user's
    // own locale, not that the suite runs in any particular time zone.
    const at = getLastAttempt()?.at ?? 0;
    expect(notes()[0]).toBe(
      `syncIcon_attemptNote(${new Date(at).toLocaleTimeString()}` +
        '|syncIcon_attemptOutcome_sent|syncIcon_attemptTrigger_mutation)'
    );
  });

  it('shows the counts, so blocks the companion already had read as not-appended', () => {
    interpolateMessages();
    recordSyncAttempt(location.href, {
      trigger: 'mutation',
      outcome: 'sent',
      sent: 141,
      appended: 0,
      superseded: 0,
    });

    buildMenuEntries(menu, 'synced', makeHandlers());

    expect(notes()).toContain('syncIcon_attemptCounts(141|0|0)');
  });

  it('omits the counts line entirely when nothing was sent', () => {
    recordSyncAttempt(location.href, { trigger: 'mutation', outcome: 'noop' });

    buildMenuEntries(menu, 'synced', makeHandlers());

    expect(notes()).toEqual(['syncIcon_attemptNote']);
  });

  it('prints the whole failure detail, never truncated', () => {
    // The failure this record exists for: a multi-sentence companion error
    // that previously reached the user only as a one-line title attribute.
    const detail =
      'Companion sync failed (500): the listener could not write ' +
      'AI/claude/a-very-long-conversation-title.md because the vault path ' +
      'resolved outside the configured root, and the request was refused.';
    recordSyncAttempt(location.href, { trigger: 'manual', outcome: 'error', sent: 4, detail });

    buildMenuEntries(menu, 'synced', makeHandlers());

    expect(notes()).toContain(detail);
  });

  it('does not repeat a detail the state note below already prints verbatim', () => {
    injectSyncIcon(makeHandlers());
    setSyncState('offline', { error: 'ECONNREFUSED' });
    menu = document.createElement('div');
    document.body.appendChild(menu);
    recordSyncAttempt(location.href, {
      trigger: 'mutation',
      outcome: 'error',
      sent: 2,
      detail: 'ECONNREFUSED',
    });

    buildMenuEntries(menu, 'offline', makeHandlers());

    expect(notes().filter(text => text === 'ECONNREFUSED')).toHaveLength(1);
  });

  it("gives each outcome's detail the same treatment as the state note for that meaning", () => {
    const expected: Record<SyncAttemptOutcome, string> = {
      sent: 'note-detail',
      noop: 'note-detail',
      blocked: 'attention-detail',
      error: 'error-detail',
      needsFullContent: 'error-detail',
    };

    for (const [outcome, className] of Object.entries(expected) as [SyncAttemptOutcome, string][]) {
      menu.innerHTML = '';
      recordSyncAttempt(location.href, { trigger: 'mutation', outcome, detail: `why ${outcome}` });

      buildMenuEntries(menu, 'synced', makeHandlers());

      const line = Array.from(menu.querySelectorAll('div')).find(
        e => e.textContent === `why ${outcome}`
      );
      expect(line?.className, `detail line for ${outcome}`).toBe(className);
    }
  });

  it('leads the menu, even while unconfigured — "nothing was attempted, and why" is the answer', () => {
    recordSyncAttempt(location.href, {
      trigger: 'mutation',
      outcome: 'blocked',
      detail: 'syncIcon_notConfigured',
    });

    buildMenuEntries(menu, 'unconfigured', makeHandlers());

    expect(Array.from(menu.children).map(child => child.className)).toEqual([
      'note-detail',
      'attention-detail',
      'entry',
    ]);
  });

  it('ignores a record for a conversation the user has already navigated away from', () => {
    recordSyncAttempt('https://claude.ai/chat/somewhere-else', {
      trigger: 'mutation',
      outcome: 'error',
      detail: 'a failure belonging to another conversation',
    });

    expect(getLastAttempt()).toBeNull();
  });

  it('is dropped on a conversation switch, like the rest of the retained detail', () => {
    recordSyncAttempt(location.href, { trigger: 'mutation', outcome: 'error', detail: 'boom' });
    expect(getLastAttempt()?.detail).toBe('boom');

    setIconContext('https://claude.ai/chat/the-next-conversation');

    expect(getLastAttempt()).toBeNull();
  });
});

describe('the "Open transcript" entry', () => {
  let menu: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    menu = document.createElement('div');
    document.body.appendChild(menu);
    injectSyncIcon(makeHandlers());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const clickOpenTranscript = (handlers: SyncIconHandlers): void => {
    buildMenuEntries(menu, 'synced', handlers);
    Array.from(menu.querySelectorAll<HTMLButtonElement>('.entry'))
      .find(e => e.textContent === 'syncIcon_openTranscript')!
      .click();
  };

  it('opens the note a sync reported, without syncing again', () => {
    setSyncState('synced', { notePath: 'AI/gemini/hello.md' });
    const handlers = makeHandlers();

    clickOpenTranscript(handlers);

    expect(handlers.onOpenPath).toHaveBeenCalledWith('AI/gemini/hello.md');
    expect(handlers.onSyncAndOpenTranscript).not.toHaveBeenCalled();
  });

  it('syncs for a path when none is known, instead of opening nothing at all', () => {
    // The bug this pins: the entry used to pass `''` to onOpenPath, whose
    // handler returns early on a falsy path — it rendered, it clicked, and
    // it did nothing, with no toast and no log.
    setIconContext('https://claude.ai/chat/never-synced-this-session');
    const handlers = makeHandlers();

    clickOpenTranscript(handlers);

    expect(handlers.onSyncAndOpenTranscript).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenPath).not.toHaveBeenCalled();
  });
});
