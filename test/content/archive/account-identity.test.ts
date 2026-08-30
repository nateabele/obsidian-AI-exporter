import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readSignedInAccountName } from '../../../src/content/archive/account-identity';

const BUTTON_SELECTOR = '[data-testid="user-menu-button"]';
const HEADER_SELECTOR = '[data-testid="user-menu-header"]';

describe('readSignedInAccountName', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the header directly, with zero clicks, when the menu is already open', async () => {
    document.body.innerHTML = `
      <button data-testid="user-menu-button"></button>
      <div data-testid="user-menu-header">nate@example.com</div>
    `;
    const button = document.querySelector(BUTTON_SELECTOR) as HTMLElement;
    const clickSpy = vi.spyOn(button, 'click');

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('nate@example.com');
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('opens the menu, reads the header, and closes the menu again when it starts closed', async () => {
    document.body.innerHTML = `<button data-testid="user-menu-button"></button>`;
    const button = document.querySelector(BUTTON_SELECTOR) as HTMLElement;
    let clickCount = 0;
    button.addEventListener('click', () => {
      clickCount += 1;
      if (clickCount === 1) {
        const header = document.createElement('div');
        header.setAttribute('data-testid', 'user-menu-header');
        header.textContent = 'nate@example.com';
        document.body.appendChild(header);
      } else {
        document.querySelector(HEADER_SELECTOR)?.remove();
      }
    });

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('nate@example.com');
    expect(clickCount).toBe(2);
    expect(document.querySelector(HEADER_SELECTOR)).toBeNull();
  });

  it('returns null without throwing when the menu button is missing', async () => {
    document.body.innerHTML = '';

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
  });

  it('returns null within the timeout and closes the menu again when the header never appears', async () => {
    document.body.innerHTML = `<button data-testid="user-menu-button"></button>`;
    const button = document.querySelector(BUTTON_SELECTOR) as HTMLElement;
    const clickSpy = vi.spyOn(button, 'click');

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it('collapses multi-line header text and trims it', async () => {
    document.body.innerHTML = `
      <button data-testid="user-menu-button"></button>
      <div data-testid="user-menu-header">
        nate@example.com
        Pro plan
      </div>
    `;

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('nate@example.com Pro plan');
  });

  it('truncates an absurdly long header to 120 characters', async () => {
    const long = 'x'.repeat(500);
    document.body.innerHTML = `
      <button data-testid="user-menu-button"></button>
      <div data-testid="user-menu-header">${long}</div>
    `;

    const promise = readSignedInAccountName();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toHaveLength(120);
    expect(result).toBe('x'.repeat(120));
  });
});
