/**
 * Reads the signed-in Claude account's display label from the page's own
 * user menu.
 *
 * `/api/organizations` (used by `claude.ts` for listing) only reports
 * *organization* names, which do not identify which of several Claude
 * logins is currently signed in — a user who imports from three separate
 * Claude accounts into one vault would see all three tagged identically.
 * The user menu (`[data-testid="user-menu-button"]` /
 * `[data-testid="user-menu-header"]`) is the one place on the page that
 * names the actual signed-in login, so it is opened, read, and closed
 * again here.
 *
 * This never throws: a failure to read a label must not cost the user
 * their import. Every failure mode (missing button, header that never
 * appears, an unexpected DOM shape) resolves to `null` instead.
 */

const USER_MENU_BUTTON_SELECTOR = '[data-testid="user-menu-button"]';
const USER_MENU_HEADER_SELECTOR = '[data-testid="user-menu-header"]';

/** Poll interval while waiting for the header to render after opening the menu. */
const HEADER_POLL_INTERVAL_MS = 50;
/** Hard cap on how long to wait for the header before giving up. */
const HEADER_TIMEOUT_MS = 2000;
/** Plenty for a login label; guards YAML frontmatter against a surprising DOM change. */
const MAX_ACCOUNT_NAME_LENGTH = 120;

function readHeaderText(): string | null {
  return document.querySelector(USER_MENU_HEADER_SELECTOR)?.textContent ?? null;
}

/**
 * `textContent` on the header can span multiple lines (name, email, plan
 * tier, ...). Collapse whitespace runs to single spaces, trim, and cap the
 * length. Returns `null` rather than an empty string when nothing
 * meaningful survives.
 */
function sanitizeAccountName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return null;
  }
  return collapsed.length > MAX_ACCOUNT_NAME_LENGTH ? collapsed.slice(0, MAX_ACCOUNT_NAME_LENGTH) : collapsed;
}

/** Polls for the header to appear, resolving `null` if it never does within the timeout. */
function waitForHeaderText(): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + HEADER_TIMEOUT_MS;
    const poll = () => {
      const text = readHeaderText();
      if (text !== null) {
        resolve(text);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, HEADER_POLL_INTERVAL_MS);
    };
    poll();
  });
}

/**
 * Reads the signed-in account's display label from the user menu, without
 * disturbing the page more than necessary:
 *  - if the header is already present (menu already open), it is read
 *    directly with zero clicks;
 *  - otherwise the menu button is clicked to open it, the header is
 *    polled for, and the button is clicked again to close it — even when
 *    the header never appears, so a timeout never leaves the user's menu
 *    hanging open.
 *
 * Intended to be called once per backfill run (see `ClaudeArchiveAdapter`)
 * rather than once per conversation, since opening/closing the menu per
 * entry would flicker the page and waste time across a listing that can
 * hold dozens of entries.
 */
export async function readSignedInAccountName(): Promise<string | null> {
  try {
    const alreadyOpen = readHeaderText();
    if (alreadyOpen !== null) {
      return sanitizeAccountName(alreadyOpen);
    }

    const button = document.querySelector<HTMLElement>(USER_MENU_BUTTON_SELECTOR);
    if (!button) {
      console.debug('[G2O] Claude user menu button not found; skipping account name');
      return null;
    }

    button.click();
    try {
      const text = await waitForHeaderText();
      if (text === null) {
        console.warn('[G2O] Claude user menu header did not appear in time; skipping account name');
        return null;
      }
      return sanitizeAccountName(text);
    } finally {
      button.click();
    }
  } catch (error) {
    console.warn('[G2O] Failed to read Claude account name', error);
    return null;
  }
}
