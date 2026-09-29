/**
 * Append mode utilities
 *
 * Core logic for looking up existing files and building appended content.
 * Combines frontmatter-parser, message-counter, and obsidian-api.
 */

import type { ObsidianApiClient } from './obsidian-api';
import type { ObsidianNote, ExtensionSettings } from './types';
import { parseFrontmatter, updateFrontmatter } from './frontmatter-parser';
import { countExistingMessages, extractTailMessages } from './message-counter';
import { formatDateWithTimezone } from './date-utils';

/**
 * Result of file lookup for append mode
 */
interface FileLookupResult {
  found: boolean;
  path: string;
  content: string;
  matchType: 'direct' | 'memo' | 'id-scan' | 'frontmatter-scan' | 'none';
}

/**
 * Result of building appended content
 */
interface AppendResult {
  /** Rebuilt file content (frontmatter + existing body + new messages) */
  content: string;
  /** Number of new messages appended */
  messagesAppended: number;
}

/**
 * Extract ID suffix from filename.
 * Extracts the portion after the last hyphen, excluding ".md" extension.
 *
 * @example extractIdSuffix("my-chat-abc12345.md") → "abc12345"
 * @example extractIdSuffix("conversation.md") → ""
 */
export function extractIdSuffix(fileName: string): string {
  const base = fileName.replace(/\.md$/, '');
  const parts = base.split('-');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** Maximum depth for the recursive ID-scan to bound API calls. */
const RECURSIVE_SCAN_MAX_DEPTH = 6;

/**
 * Cap on frontmatter GETs performed by {@link frontmatterScan}, the fallback used when
 * a filename carries no id suffix to pre-filter on (human-readable filenames have none).
 * `AI/chatgpt/` alone holds on the order of 1,500 notes; without a cap, one retitled or
 * rolled-over conversation could turn a save into over a thousand sequential GETs. Title
 * plausibility ranking (see {@link rankByTitlePlausibility}) makes a real match likely to
 * land near the front of the list, so this budget is generous for the common case (an
 * edited title still shares most of its words) while still bounding the worst case. A
 * miss here is recoverable — the caller falls through to creating a new note — a hung
 * sync is not.
 *
 * Exported only so tests can assert the cap without duplicating the number.
 */
export const FRONTMATTER_SCAN_MAX_CANDIDATES = 40;

/**
 * Look up an existing file for a conversation.
 *
 * Strategy (ordered by cost):
 * 1. Direct path: GET fullPath → verify frontmatter ID
 * 2. When the computed filename carries an id suffix (`-{idSuffix}.md`, still produced
 *    for legacy and migrated notes):
 *    2a. ID scan (flat): listFiles(resolvedPath) → filter by ID suffix → verify frontmatter ID
 *    2b. ID scan (recursive): when {@link searchBasePath} differs from resolvedPath
 *        (i.e. the vault-path template contains date variables), walk subdirectories
 *        from searchBasePath looking for `-{idSuffix}.md` matches. This lets append-mode
 *        find a previous-month file even when the current resolved path points at a
 *        not-yet-existing folder.
 * 3. Otherwise (human-readable filename, no id suffix to filter on): frontmatter scan.
 *    A title edited since the note was written, or a date-template folder rolling over
 *    into a new month, moves the computed path without changing the note's frontmatter
 *    id — list the candidate directory (or walk subdirectories, same as 2b) and verify
 *    frontmatter id directly, ranked by title plausibility and capped at
 *    {@link FRONTMATTER_SCAN_MAX_CANDIDATES} GETs so a large folder can't hang a save.
 * 4. Not found
 *
 * @param searchBasePath - Optional. When provided AND different from resolvedPath,
 *   triggers the recursive scan. Defaults to resolvedPath (preserves the legacy
 *   flat-scan behaviour for templates without date variables).
 * @param hintPath - Optional. Path where this conversation's file was previously
 *   found (caller-memoized). Tried before anything else so repeat appends after
 *   a calendar rollover cost one GET instead of a directory scan.
 */
export async function lookupExistingFile(
  client: ObsidianApiClient,
  fullPath: string,
  resolvedPath: string,
  note: ObsidianNote,
  searchBasePath: string = resolvedPath,
  hintPath?: string
): Promise<FileLookupResult> {
  const expectedId = note.frontmatter.id;

  // Step 0: Caller-memoized hint (id re-verified — the memo may be stale)
  if (hintPath && hintPath !== fullPath) {
    const hintContent = await client.getFile(hintPath);
    if (hintContent !== null) {
      const parsed = parseFrontmatter(hintContent);
      if (parsed?.fields.id === expectedId) {
        return { found: true, path: hintPath, content: hintContent, matchType: 'memo' };
      }
    }
  }

  // Step 1: Direct path match
  const directContent = await client.getFile(fullPath);
  if (directContent !== null) {
    const parsed = parseFrontmatter(directContent);
    if (parsed?.fields.id === expectedId) {
      return { found: true, path: fullPath, content: directContent, matchType: 'direct' };
    }
  }

  // Step 2: ID suffix scan (cheap: one listFiles + a handful of reads narrowed by suffix)
  const idSuffix = extractIdSuffix(note.fileName);
  const useRecursive = searchBasePath !== resolvedPath && searchBasePath !== '';

  const scanResult = idSuffix
    ? await suffixScan(
        client,
        idSuffix,
        expectedId,
        fullPath,
        resolvedPath,
        searchBasePath,
        useRecursive
      )
    : await unsuffixedScan(
        client,
        note,
        expectedId,
        fullPath,
        resolvedPath,
        searchBasePath,
        useRecursive
      );
  if (scanResult) return scanResult;

  // Step 3: Not found
  return { found: false, path: fullPath, content: '', matchType: 'none' };
}

/**
 * Step 2a/2b for filenames that carry an id suffix: the cheap, suffix-narrowed scan
 * (flat or recursive depending on whether the vault-path template uses date variables).
 */
async function suffixScan(
  client: ObsidianApiClient,
  idSuffix: string,
  expectedId: string,
  fullPath: string,
  resolvedPath: string,
  searchBasePath: string,
  useRecursive: boolean
): Promise<FileLookupResult | null> {
  if (useRecursive) {
    return recursiveIdScan(
      client,
      searchBasePath,
      idSuffix,
      expectedId,
      fullPath,
      RECURSIVE_SCAN_MAX_DEPTH
    );
  }
  if (resolvedPath) {
    return flatIdScan(client, resolvedPath, idSuffix, expectedId, fullPath);
  }
  return null;
}

/**
 * Step 2 for filenames with no id suffix (human-readable filenames): every note in the
 * candidate set is name-only until its frontmatter is read, so this ranks by title
 * plausibility and caps the reads (see {@link frontmatterScan}) instead of giving up
 * outright the way a suffix-only scan would.
 */
async function unsuffixedScan(
  client: ObsidianApiClient,
  note: ObsidianNote,
  expectedId: string,
  fullPath: string,
  resolvedPath: string,
  searchBasePath: string,
  useRecursive: boolean
): Promise<FileLookupResult | null> {
  const title = note.frontmatter.title;
  const candidates = useRecursive
    ? await collectRecursiveCandidates(client, searchBasePath, RECURSIVE_SCAN_MAX_DEPTH)
    : resolvedPath
      ? (await client.listFiles(resolvedPath)).map(name => ({ dir: resolvedPath, name }))
      : [];

  const scanned = await frontmatterScan(
    client,
    candidates,
    title,
    expectedId,
    fullPath,
    FRONTMATTER_SCAN_MAX_CANDIDATES
  );
  if (scanned) return scanned;

  if (candidates.length > 0) {
    console.info('[G2O] Append lookup: no unsuffixed candidate matched by frontmatter id', {
      id: expectedId,
      title,
      candidatesSeen: candidates.length,
      candidatesRead: Math.min(candidates.length, FRONTMATTER_SCAN_MAX_CANDIDATES),
    });
  }
  return null;
}

/**
 * Scan a single directory for any `.md` file whose name ends in `-{idSuffix}.md`
 * and whose frontmatter id matches expectedId. Returns the first match, or null.
 *
 * Non-recursive sibling of {@link recursiveIdScan}, used when the vault path
 * template has no date variables (legacy flat-scan behaviour).
 */
async function flatIdScan(
  client: ObsidianApiClient,
  dir: string,
  idSuffix: string,
  expectedId: string,
  skipPath: string
): Promise<FileLookupResult | null> {
  const files = await client.listFiles(dir);
  for (const file of files) {
    if (!file.endsWith(`-${idSuffix}.md`)) continue;
    const candidatePath = `${dir}/${file}`;
    if (candidatePath === skipPath) continue; // Already checked as direct match
    const content = await client.getFile(candidatePath);
    if (content === null) continue;
    const parsed = parseFrontmatter(content);
    if (parsed?.fields.id === expectedId) {
      return { found: true, path: candidatePath, content, matchType: 'id-scan' };
    }
  }

  return null;
}

/**
 * Walk subdirectories from baseDir up to maxDepth, looking for any `.md` file
 * whose name ends in `-{idSuffix}.md` and whose frontmatter id matches expectedId.
 * Returns the first match, or null when exhausted.
 */
async function recursiveIdScan(
  client: ObsidianApiClient,
  baseDir: string,
  idSuffix: string,
  expectedId: string,
  skipPath: string,
  maxDepth: number
): Promise<FileLookupResult | null> {
  type Frame = { dir: string; depth: number };
  const queue: Frame[] = [{ dir: baseDir, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as Frame;
    const entries = await client.listEntries(dir);
    for (const entry of entries) {
      if (entry.endsWith('/')) {
        if (depth + 1 <= maxDepth) {
          const subdir = entry.slice(0, -1);
          queue.push({ dir: `${dir}/${subdir}`, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.endsWith(`-${idSuffix}.md`)) continue;
      const candidatePath = `${dir}/${entry}`;
      if (candidatePath === skipPath) continue;
      const content = await client.getFile(candidatePath);
      if (content === null) continue;
      const parsed = parseFrontmatter(content);
      if (parsed?.fields.id === expectedId) {
        return { found: true, path: candidatePath, content, matchType: 'id-scan' };
      }
    }
  }

  return null;
}

/** A frontmatter-scan candidate: a filename together with the directory that holds it. */
interface ScanCandidate {
  dir: string;
  name: string;
}

/**
 * Lowercase word tokens of a title or filename stem, for plausibility ranking only —
 * never for correctness. `.md` is stripped so a filename and a title tokenize the same
 * way.
 */
function titleTokens(value: string): Set<string> {
  return new Set(
    value
      .replace(/\.md$/i, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(token => token.length > 0)
  );
}

/**
 * Order scan candidates by how many word-tokens their filename shares with the note's
 * current title, most-plausible first (ties keep directory-listing order). An edited
 * title still shares most of its words with the old one, so this makes a real match
 * likely to land near the front of a capped scan. It is a ranking heuristic only —
 * {@link frontmatterScan} still verifies every candidate it opens against frontmatter
 * id before accepting it.
 */
function rankByTitlePlausibility(candidates: ScanCandidate[], title: string): ScanCandidate[] {
  const targetTokens = titleTokens(title);
  if (targetTokens.size === 0) return candidates;

  return candidates
    .map((candidate, index) => {
      let shared = 0;
      for (const token of titleTokens(candidate.name)) {
        if (targetTokens.has(token)) shared++;
      }
      return { candidate, index, shared };
    })
    .sort((a, b) => b.shared - a.shared || a.index - b.index)
    .map(entry => entry.candidate);
}

/**
 * Frontmatter-verify fallback for filenames with no id suffix to pre-filter on
 * (human-readable filenames). Every `.md` candidate is name-only until opened, so this
 * ranks by title plausibility (see {@link rankByTitlePlausibility}) and reads at most
 * `budget` of them, verifying frontmatter id and stopping at the first match. Returns
 * null when the budget is exhausted or the folder has no matching note — the caller is
 * responsible for treating that as "not found", not as an error.
 */
async function frontmatterScan(
  client: ObsidianApiClient,
  candidates: ScanCandidate[],
  title: string,
  expectedId: string,
  skipPath: string,
  budget: number
): Promise<FileLookupResult | null> {
  const mdCandidates = candidates.filter(candidate => candidate.name.endsWith('.md'));
  const ranked = rankByTitlePlausibility(mdCandidates, title);

  let reads = 0;
  for (const { dir, name } of ranked) {
    if (reads >= budget) break;
    const candidatePath = `${dir}/${name}`;
    if (candidatePath === skipPath) continue; // Already checked as direct match

    reads++;
    const content = await client.getFile(candidatePath);
    if (content === null) continue;
    const parsed = parseFrontmatter(content);
    if (parsed?.fields.id === expectedId) {
      return { found: true, path: candidatePath, content, matchType: 'frontmatter-scan' };
    }
  }

  return null;
}

/**
 * Walk subdirectories from baseDir up to maxDepth collecting every `.md` file name
 * (no id suffix to filter by, so nothing is excluded here — filtering happens by
 * frontmatter in {@link frontmatterScan}). Directory listings are name-only API calls;
 * the expensive part (content GETs) is bounded separately by the scan's own budget.
 */
async function collectRecursiveCandidates(
  client: ObsidianApiClient,
  baseDir: string,
  maxDepth: number
): Promise<ScanCandidate[]> {
  type Frame = { dir: string; depth: number };
  const queue: Frame[] = [{ dir: baseDir, depth: 0 }];
  const candidates: ScanCandidate[] = [];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as Frame;
    const entries = await client.listEntries(dir);
    for (const entry of entries) {
      if (entry.endsWith('/')) {
        if (depth + 1 <= maxDepth) {
          const subdir = entry.slice(0, -1);
          queue.push({ dir: `${dir}/${subdir}`, depth: depth + 1 });
        }
        continue;
      }
      candidates.push({ dir, name: entry });
    }
  }

  return candidates;
}

/**
 * Build appended file content.
 * Returns null if no new messages to append or cannot parse existing content.
 */
export function buildAppendContent(
  existingContent: string,
  note: ObsidianNote,
  settings: ExtensionSettings
): AppendResult | null {
  // 1. Parse existing frontmatter
  const parsed = parseFrontmatter(existingContent);
  if (!parsed) return null;

  // 2. Count existing messages
  const existingCount = countExistingMessages(parsed.body);
  if (existingCount === 0) return null; // Cannot detect message boundaries

  // 3. Compare counts
  const newTotal = note.frontmatter.message_count;
  if (newTotal <= existingCount) return null; // No new messages

  // 4. Extract tail messages from the new formatted body
  // (note.body is exactly what generateNoteContent would embed after the frontmatter)
  const newMessages = extractTailMessages(note.body, existingCount);
  if (!newMessages) return null;

  // 5. Update frontmatter fields
  const timezone = settings.templateOptions.timezone ?? 'UTC';
  const updatedRaw = updateFrontmatter(parsed.raw, {
    modified: formatDateWithTimezone(new Date(), timezone),
    message_count: newTotal,
  });

  // 6. Rebuild: updated frontmatter + existing body + separator + new messages
  const content = updatedRaw + '\n' + parsed.body + '\n\n' + newMessages;

  return {
    content,
    messagesAppended: newTotal - existingCount,
  };
}
