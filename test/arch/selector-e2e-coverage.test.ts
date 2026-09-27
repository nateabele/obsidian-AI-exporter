/**
 * Fitness function: selector group <-> e2e smoke test SSOT.
 *
 * Selector rot is structurally invisible to `npm test`: the unit-test DOM
 * fixtures (`test/fixtures/dom-helpers.ts`) are hand-built and don't track
 * live site markup, so every extractor selector can go stale (match zero on
 * the real DOM) while all unit tests keep passing. The only thing that
 * actually notices is `e2e/selectors/smoke-test.spec.ts`, which queries the
 * live DOM — but only for the selector groups it's told about, via the
 * `selectorGroups` object literal passed to `runPlatformValidation()` in
 * each `test.describe()` block.
 *
 * That map is hand-maintained and nothing forces it to track new exports:
 * add a new selector group to a platform file (e.g. a new Gem-conversation
 * variant) and forget to wire it into the smoke test, and it validates
 * against nothing — the exact kind of silent gap this suite exists to close.
 *
 * Mirrors test/arch/platform-ssot.test.ts and archive-ssot.test.ts: read the
 * relevant source files as text (rather than importing the spec file, which
 * would drag in Playwright's test runner) and diff the two SSOTs.
 *
 * COMPUTED_SELECTORS / JOINED_SELECTORS are excluded — same rationale as
 * documented in selectors/index.ts: they're extractor-internal derived
 * values (pre-joined query strings), not raw SelectorGroup exports the smoke
 * test validates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

const SELECTORS_DIR = 'src/content/extractors/selectors';
const PLATFORM_FILES = ['gemini', 'claude', 'chatgpt', 'perplexity', 'notebooklm'];

// Extractor-internal derived exports, never raw selector groups (see index.ts
// header comment — this list must stay in sync with it).
const INTERNAL_ONLY_EXPORTS = new Set(['COMPUTED_SELECTORS', 'JOINED_SELECTORS']);

interface RawExport {
  file: string;
  name: string;
}

/** Every `export const NAME = {...}` in a platform selector file. */
function rawExportsOf(file: string): RawExport[] {
  const source = read(`${SELECTORS_DIR}/${file}.ts`);
  return [...source.matchAll(/^export const (\w+)\s*=/gm)]
    .map(m => m[1])
    .filter(name => !INTERNAL_ONLY_EXPORTS.has(name))
    .map(name => ({ file, name }));
}

const allRawExports = PLATFORM_FILES.flatMap(rawExportsOf);

/** name/alias pairs re-exported per source file in selectors/index.ts. */
function indexReexports(source: string): Map<string, Map<string, string>> {
  // e.g. `export { SELECTORS as GEMINI_SELECTORS, ... } from './gemini';`
  const byFile = new Map<string, Map<string, string>>();
  for (const block of source.matchAll(/export\s*\{([^}]+)\}\s*from\s*'\.\/(\w+)';/g)) {
    const [, body, file] = block;
    const aliases = new Map<string, string>();
    for (const item of body.split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(trimmed) ?? /^(\w+)$/.exec(trimmed);
      expect(asMatch, `unparseable re-export entry "${trimmed}" in selectors/index.ts`).not.toBeNull();
      const [, name, alias] = asMatch!;
      aliases.set(name, alias ?? name);
    }
    byFile.set(file, aliases);
  }
  return byFile;
}

const indexSource = read(`${SELECTORS_DIR}/index.ts`);
const reexportsByFile = indexReexports(indexSource);
const smokeTestSource = read('e2e/selectors/smoke-test.spec.ts');

describe('architecture: selector group <-> e2e smoke test SSOT', () => {
  it.each(allRawExports.map(e => `${e.file}:${e.name}`))(
    '%s is re-exported from selectors/index.ts',
    label => {
      const [file, name] = label.split(':');
      const aliases = reexportsByFile.get(file);
      expect(
        aliases?.has(name),
        `selectors/${file}.ts exports "${name}" but selectors/index.ts doesn't re-export it — ` +
          `the e2e smoke test can only see selector groups that pass through index.ts`
      ).toBe(true);
    }
  );

  it.each(allRawExports.map(e => `${e.file}:${e.name}`))(
    '%s reaches the smoke test\'s selectorGroups map',
    label => {
      const [file, name] = label.split(':');
      const alias = reexportsByFile.get(file)?.get(name);
      expect(alias, `no index.ts alias found for ${file}:${name}`).toBeDefined();

      // The smoke test wires each group in as `<groupName>: <ALIAS>` inside
      // the object literal passed to runPlatformValidation(). Matching on
      // `: ALIAS` (rather than a bare word match) distinguishes real usage
      // from the import statement, which lists every alias whether or not
      // it's actually validated.
      const usedAsValue = new RegExp(`:\\s*${alias}\\b`).test(smokeTestSource);
      expect(
        usedAsValue,
        `selectors/index.ts exports "${alias}" (from selectors/${file}.ts's "${name}") but ` +
          `e2e/selectors/smoke-test.spec.ts never passes it into a selectorGroups map — ` +
          `this selector group is never validated against the live DOM. Add it to the ` +
          `relevant test.describe() block's runPlatformValidation() call.`
      ).toBe(true);
    }
  );
});
