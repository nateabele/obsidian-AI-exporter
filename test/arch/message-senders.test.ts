/**
 * Fitness function: no vestigial message actions.
 *
 * VALID_MESSAGE_ACTIONS (src/lib/constants.ts) is the whitelist the background
 * worker accepts. Every whitelisted action must have at least one live sender
 * in the client layers (src/content/, src/popup/) — an action with handlers
 * and validation but no sender is dead surface that still carries security
 * review weight (see the saveToObsidian/getExistingFile removal, analysis
 * 2026-07-04).
 *
 * Senders are detected as `action: '<name>'` object literals, the only form
 * used with sendMessage() in this codebase.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

/** Collect all .ts sources under a directory, recursively. */
function collectSources(rel: string): string[] {
  const abs = path.join(root, rel);
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf-8'));
    }
  }
  return out;
}

// Extract the whitelist from constants.ts without importing chrome-flavored code.
const constantsSource = read('src/lib/constants.ts');
const whitelistMatch = constantsSource.match(
  /VALID_MESSAGE_ACTIONS\s*=\s*\[([^\]]+)\]/
);
if (!whitelistMatch) {
  throw new Error('VALID_MESSAGE_ACTIONS not found in src/lib/constants.ts');
}
const actions = [...whitelistMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

const clientSources = [...collectSources('src/content'), ...collectSources('src/popup')];

/**
 * Actions whose sender lands in a later task of the same plan. The
 * companion-sync client (src/lib/companion-client.ts) and its `chatSync`
 * route are wired into the background worker ahead of the content-script
 * caller that will drive it (auto-sync-companion plan). Remove an entry
 * here once its sender exists.
 */
const PENDING_SENDER_EXEMPTIONS = new Set(['chatSync']);

describe('architecture: message actions have live senders', () => {
  it('extracts a non-empty whitelist', () => {
    expect(actions.length).toBeGreaterThan(0);
  });

  it.each(actions.filter(action => !PENDING_SENDER_EXEMPTIONS.has(action)))(
    'action "%s" is sent by at least one client',
    action => {
      const sender = new RegExp(`action:\\s*'${action}'`);
      const hasSender = clientSources.some(src => sender.test(src));
      expect(
        hasSender,
        `"${action}" is whitelisted in VALID_MESSAGE_ACTIONS but no client in ` +
          `src/content/ or src/popup/ sends it — remove the action or its whitelist entry`
      ).toBe(true);
    }
  );
});
