/**
 * Fitness function: archive-backfill platform Single Source of Truth.
 *
 * `ARCHIVE_SUPPORTED_PLATFORMS` (src/lib/constants.ts) gates the popup's
 * "Import history" button; `ARCHIVE_ADAPTER_CONSTRUCTORS` (src/content/archive/discover.ts)
 * is the actual registry of platforms with a working `ArchiveAdapter`. Nothing
 * ties the two together at compile time (constants.ts can't import discover.ts —
 * it would pull adapter classes into `lib/`, violating ADR-012's layering rule
 * enforced by test/arch/layering.test.ts), so drift is silent in both directions:
 *
 *   - add a platform to constants only  -> button enables, discovery throws
 *     "not supported"
 *   - add an adapter only               -> button stays permanently disabled
 *
 * This mirrors test/arch/platform-ssot.test.ts's approach: read discover.ts's
 * source text (rather than importing it, which would drag adapter modules —
 * and their own fetch/DOM assumptions — into this test) and diff its keys
 * against the real, imported ARCHIVE_SUPPORTED_PLATFORMS constant.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ARCHIVE_SUPPORTED_PLATFORMS } from '../../src/lib/constants';

const root = path.resolve(import.meta.dirname, '../..');
const discoverSource = fs.readFileSync(path.join(root, 'src/content/archive/discover.ts'), 'utf-8');

function adapterRegistryPlatforms(source: string): string[] {
  // Non-greedy up to the first `= {` after the identifier: a plain `[^=]*`
  // would stop at the `=>` inside the declared type
  // (`new () => ArchiveAdapter`) instead of the real assignment.
  const match = /ARCHIVE_ADAPTER_CONSTRUCTORS[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(source);
  expect(
    match,
    'ARCHIVE_ADAPTER_CONSTRUCTORS object literal not found in discover.ts'
  ).not.toBeNull();
  const body = match![1];
  return [...body.matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
}

describe('architecture: archive backfill platform SSOT (constants <-> discover)', () => {
  const adapterPlatforms = adapterRegistryPlatforms(discoverSource);

  it('every ARCHIVE_SUPPORTED_PLATFORMS entry has a matching ArchiveAdapter registered', () => {
    for (const platform of ARCHIVE_SUPPORTED_PLATFORMS) {
      expect(
        adapterPlatforms,
        `"${platform}" is in ARCHIVE_SUPPORTED_PLATFORMS but discover.ts's ARCHIVE_ADAPTER_CONSTRUCTORS has no entry for it — the Import history button would enable with nothing to discover`
      ).toContain(platform);
    }
  });

  it('every registered ArchiveAdapter platform is advertised in ARCHIVE_SUPPORTED_PLATFORMS', () => {
    for (const platform of adapterPlatforms) {
      expect(
        ARCHIVE_SUPPORTED_PLATFORMS as readonly string[],
        `discover.ts registers an ArchiveAdapter for "${platform}" but it's missing from ARCHIVE_SUPPORTED_PLATFORMS — the Import history button would stay permanently disabled on that platform`
      ).toContain(platform);
    }
  });
});
