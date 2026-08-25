import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deriveState, injectSyncIcon, setSyncState } from '../../src/content/sync-icon';
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
    expect(entries).toEqual(['Open settings']);

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
    expect(entries).toEqual(['Retry', 'Sync now', 'Open transcript']);
  });

  it('offers "Sync now" and "Open transcript" once synced', () => {
    const handlers = makeHandlers();
    injectSyncIcon(handlers);
    setSyncState('synced', { notePath: 'AI/gemini/hello.md' });

    document.getElementById('g2o-sync-icon')?.click();

    const entries = Array.from(document.querySelectorAll('#g2o-sync-menu .entry'));
    expect(entries.map(e => e.textContent)).toEqual(['Sync now', 'Open transcript']);

    entries[1].dispatchEvent(new Event('click'));
    expect(handlers.onOpenPath).toHaveBeenCalledWith('AI/gemini/hello.md');
  });
});
