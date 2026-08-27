import { describe, it, expect, beforeEach } from 'vitest';
import { isSelfInflictedMutation } from '../../src/content/bootstrap';

/**
 * getObservationRoot() falls back to document.body when a platform's root
 * selectors do not match. Both the sync icon (#g2o-sync-icon) and its menu
 * (#g2o-sync-menu) are appended to document.body, so on that fallback the
 * auto-sync observer watches its own UI: every repaint mutates the observed
 * subtree, retriggers the debounce, and the page burns CPU in a 4s sync loop
 * forever. Selector drift is the likeliest failure mode this project has, so
 * the fallback has to be safe rather than merely present.
 */
describe('isSelfInflictedMutation', () => {
  let icon: HTMLElement;
  let menu: HTMLElement;
  let pageNode: HTMLElement;

  const record = (over: Partial<MutationRecord> & { target: Node }) =>
    ({ addedNodes: [], removedNodes: [], ...over }) as unknown as MutationRecord;

  beforeEach(() => {
    document.body.innerHTML = '';
    icon = document.createElement('button');
    icon.id = 'g2o-sync-icon';
    menu = document.createElement('div');
    menu.id = 'g2o-sync-menu';
    pageNode = document.createElement('article');
    document.body.append(icon, menu, pageNode);
  });

  it('treats a mutation targeting the icon itself as self-inflicted', () => {
    expect(isSelfInflictedMutation(record({ target: icon }))).toBe(true);
  });

  it('treats a mutation deep inside the menu as self-inflicted', () => {
    const entry = document.createElement('button');
    menu.appendChild(entry);
    expect(isSelfInflictedMutation(record({ target: entry }))).toBe(true);
  });

  it('treats a text-node mutation inside our UI as self-inflicted', () => {
    const text = document.createTextNode('Syncing');
    icon.appendChild(text);
    expect(isSelfInflictedMutation(record({ target: text }))).toBe(true);
  });

  it('treats appending our menu to body as self-inflicted', () => {
    expect(
      isSelfInflictedMutation(record({ target: document.body, addedNodes: [menu] as unknown as NodeList }))
    ).toBe(true);
  });

  it('treats removing our menu from body as self-inflicted', () => {
    expect(
      isSelfInflictedMutation(record({ target: document.body, removedNodes: [menu] as unknown as NodeList }))
    ).toBe(true);
  });

  it('does NOT treat a real page mutation as self-inflicted', () => {
    expect(
      isSelfInflictedMutation(record({ target: document.body, addedNodes: [pageNode] as unknown as NodeList }))
    ).toBe(false);
  });

  it('does NOT treat a mutation targeting page content as self-inflicted', () => {
    expect(isSelfInflictedMutation(record({ target: pageNode }))).toBe(false);
  });

  it('does NOT suppress a batch that mixes our UI with real page content', () => {
    // A genuine new message arriving in the same batch as an icon repaint
    // must still trigger a sync -- suppressing it would lose the message.
    expect(
      isSelfInflictedMutation(
        record({ target: document.body, addedNodes: [menu, pageNode] as unknown as NodeList })
      )
    ).toBe(false);
  });

  it('does NOT treat a bare childList record with no touched nodes as self-inflicted', () => {
    // Nothing identifies it as ours, so it must be allowed through rather
    // than silently swallowed.
    expect(isSelfInflictedMutation(record({ target: document.body }))).toBe(false);
  });
});
