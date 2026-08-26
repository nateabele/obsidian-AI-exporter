/**
 * Fitness function: the sync icon's stale-paint / stale-detail invariants.
 *
 * `src/content/sync-icon.ts` went through five fix rounds establishing two
 * rules the file's own doc comments describe but nothing enforced:
 *
 * 1. Any paint that spans an `await` must go through `paintFor(href, ...)`,
 *    which drops the paint if `href` no longer matches the current
 *    conversation context — never through `setSyncState()` directly, which
 *    paints unconditionally. `setSyncState` is exported (sync-icon.test.ts
 *    legitimately drives it directly to unit-test the paint itself), but no
 *    OTHER module may import it — every other call site's result can be
 *    stale by the time it resolves.
 * 2. Every piece of "retained detail" (state that describes a specific
 *    conversation — the last error, note path, suggestion count/list) is
 *    reset in `setIconContext()` on every conversation switch, so it can
 *    never leak from one conversation's icon into another's. A retained
 *    `let` added without wiring it into `setIconContext()` is exactly the
 *    Critical that 1280 passing tests missed on the very next task after
 *    round five — this test would have caught it.
 *
 * Both checks are plain regex/text scans (see message-senders.test.ts for
 * the same style), not an AST walk — cheap, and precise enough for the
 * narrow shape being enforced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const SYNC_ICON_REL = 'src/content/sync-icon.ts';
const syncIconSource = fs.readFileSync(path.join(root, SYNC_ICON_REL), 'utf-8');

/** Collect all .ts sources under src/, recursively, as [relPath, content] pairs. */
function collectSrcSources(): [string, string][] {
  const abs = path.join(root, 'src');
  const out: [string, string][] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const fileAbs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, fileAbs).split(path.sep).join('/');
    out.push([rel, fs.readFileSync(fileAbs, 'utf-8')]);
  }
  return out;
}

describe('architecture: sync-icon retained-state invariants', () => {
  it('no file outside sync-icon.ts imports setSyncState', () => {
    // A named import of setSyncState specifically — not any textual mention
    // (sync-icon.ts's own doc comments reference it by name constantly, and
    // that's fine; an IMPORT is the bypass this guards against).
    const importsSetSyncState = /\bimport\s*\{[^}]*\bsetSyncState\b[^}]*\}\s*from/;

    for (const [rel, source] of collectSrcSources()) {
      if (rel === SYNC_ICON_REL) continue;
      expect(
        importsSetSyncState.test(source),
        `${rel} imports setSyncState directly from sync-icon.ts. setSyncState() paints ` +
          'unconditionally, with no check that the conversation it started under is still ' +
          "the one on screen. Any call site whose result can be stale by the time it resolves " +
          '(anything spanning an `await`) must go through paintFor(href, ...) instead, which ' +
          'drops a stale paint rather than letting it land on the wrong conversation.'
      ).toBe(false);
    }
  });

  it('every retained-detail module-level let in sync-icon.ts is cleared in setIconContext', () => {
    const lines = syncIconSource.split('\n');
    const letDeclaration = /^let\s+(\w+)/;
    const isCommentLine = (line: string): boolean => {
      const t = line.trim();
      return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
    };

    const contextMatch = syncIconSource.match(
      /export function setIconContext\([^)]*\)[^{]*\{([\s\S]*?)\n\}/
    );
    if (!contextMatch) {
      throw new Error('setIconContext() not found in sync-icon.ts — invariant cannot be checked');
    }
    const setIconContextBody = contextMatch[1];

    const allLets: string[] = [];
    const retainedLets: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(letDeclaration);
      if (!m) continue;
      allLets.push(m[1]);

      // The contiguous comment block immediately above the declaration (no
      // blank line in between) — this is where "retained" is documented in
      // this file's existing style (see lastError/currentSuggestions/
      // contextHref vs. activeMenu/activeOutsideClickListener, which are
      // live menu UI state, not per-conversation detail, and deliberately
      // aren't reset here).
      let j = i - 1;
      const commentLines: string[] = [];
      while (j >= 0 && isCommentLine(lines[j])) {
        commentLines.unshift(lines[j]);
        j -= 1;
      }
      if (/retained/i.test(commentLines.join('\n'))) {
        retainedLets.push(m[1]);
      }
    }

    // Sanity checks so this test can't silently degrade into a no-op if the
    // file's comment convention or setIconContext() itself disappears.
    expect(allLets.length, 'no module-level `let` found in sync-icon.ts').toBeGreaterThan(0);
    expect(
      retainedLets.length,
      'no `let` documented as "retained" was found — either the convention this test relies ' +
        'on was dropped from the doc comments, or all retained state was removed'
    ).toBeGreaterThan(0);

    for (const name of retainedLets) {
      const assignedInContext = new RegExp(`\\b${name}\\s*=(?!=)`).test(setIconContextBody);
      expect(
        assignedInContext,
        `\`${name}\` is documented as retained per-conversation detail but is never reset in ` +
          'setIconContext(). Retained detail that survives a conversation switch leaks the ' +
          "previous conversation's state (error/note path/suggestions) into the new one — add " +
          '`' +
          name +
          ' = <reset value>;` to setIconContext(), or remove the "retained" wording from its ' +
          'doc comment if it genuinely is not per-conversation state.'
      ).toBe(true);
    }
  });
});
