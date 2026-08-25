import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deriveState,
  injectSyncIcon,
  setSyncState,
  getLastError,
} from '../../src/content/sync-icon';
import type { SyncIconHandlers } from '../../src/content/sync-icon';

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
    expect(entries).toEqual(['syncIcon_retry', 'syncIcon_syncNow', 'syncIcon_openTranscript']);
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
