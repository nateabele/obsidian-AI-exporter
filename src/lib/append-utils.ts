/**
 * Append mode utilities
 *
 * Core logic for looking up existing files and building appended content.
 * Combines frontmatter-parser, message-counter, and obsidian-api.
 */

import type { ObsidianApiClient } from './obsidian-api';
import type { ObsidianNote, ExtensionSettings, FilenameScheme } from './types';
import { SCAN_MAX_REQUESTS } from './constants';
import { parseFrontmatter, updateFrontmatter, type LineEnding } from './frontmatter-parser';
import { classifyNoteProbe, isSameConversation, type NoteProbe } from './note-identity';
import { countExistingMessages, extractTailMessages, unterminatedFence } from './message-counter';
import { formatDateWithTimezone } from './date-utils';

/**
 * Why a lookup failed to find the conversation's existing note (issue #365).
 *
 * A miss makes the save path fork a new file, so when a duplicate turns up in
 * the wild this is the single most useful thing to know. Reported, never acted
 * on — the lookup's behaviour is unchanged.
 *
 * - `empty-directory` — the listing returned nothing. `listEntries()` maps a
 *   404 to `[]`, and the Local REST API documents both "directory does not
 *   exist" (404) and that empty directories are not returned, so a missing
 *   folder, an empty one and a swallowed error all look identical here.
 * - `no-candidate-file` — the folder had files, none of them a candidate.
 * - `candidate-id-mismatch` — candidate files existed but none were ours.
 * - `budget-exhausted` — the scan hit {@link SCAN_MAX_REQUESTS} first, so the
 *   note may well exist beyond the point the scan stopped.
 *
 * There is deliberately no "no scan was possible" reason any more. It used to
 * exist (`no-candidate-suffix`) for a `title-id` name carrying no id suffix —
 * the shape human-readable filenames now always have, so refusing to scan
 * there is exactly the bug that forked a duplicate per conversation. Such a
 * name now scans by frontmatter instead; see {@link createCandidateScan}.
 */
type LookupMissReason =
  'empty-directory' | 'no-candidate-file' | 'candidate-id-mismatch' | 'budget-exhausted';

/**
 * Result of file lookup for append mode
 */
interface FileLookupResult {
  found: boolean;
  path: string;
  content: string;
  matchType: 'direct' | 'memo' | 'id-scan' | 'frontmatter-scan' | 'none';
  /** Only on a miss: which negative occurred (issue #365). */
  missReason?: LookupMissReason;
  /** What the direct-path GET saw. Absent when a memo hit short-circuited it. */
  directProbe?: NoteProbe;
}

/**
 * Result of building appended content
 */
interface AppendResult {
  /**
   * Rebuilt file content (frontmatter + existing body + new messages),
   * **LF-normalised**.
   *
   * The file's own ending is NOT restored here: the caller may still transform
   * the body (callout flattening), and those transforms are written against LF
   * per ADR-026. Restoring early left them matching against a trailing `\r` —
   * see {@link eol}.
   */
  content: string;
  /** Number of new messages appended */
  messagesAppended: number;
  /**
   * The line ending the existing file used. The caller must apply this as the
   * LAST step before writing, after any body transform (ADR-026).
   */
  eol: LineEnding;
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
 * Options for {@link lookupExistingFile}.
 */
export interface LookupOptions {
  /**
   * When provided AND different from resolvedPath, triggers the recursive scan.
   * Defaults to resolvedPath (preserves the flat-scan behaviour for templates
   * without date variables).
   */
  searchBasePath?: string;
  /**
   * Path where this conversation's file was previously found (caller-memoized).
   * Tried before anything else so repeat appends after a calendar rollover cost
   * one GET instead of a directory scan.
   */
  hintPath?: string;
  /**
   * File-naming scheme in effect. Decides how scan candidates are pre-filtered;
   * see {@link createCandidateScan}. Defaults to `'title-id'`.
   */
  filenameScheme?: FilenameScheme;
}

/** Bounded request allowance shared by a single lookup's directory scan. */
interface ScanBudget {
  /** Consume one request. Returns false once the allowance is exhausted. */
  spend(): boolean;
  /** True once the allowance is used up; lets callers stop iterating early. */
  readonly exhausted: boolean;
}

function createScanBudget(max: number): ScanBudget {
  let used = 0;
  return {
    spend(): boolean {
      if (used >= max) return false;
      used++;
      return true;
    },
    get exhausted(): boolean {
      return used >= max;
    },
  };
}

/** Uniform "no existing file" result. */
function notFound(
  fullPath: string,
  missReason: LookupMissReason,
  directProbe?: NoteProbe
): FileLookupResult {
  return { found: false, path: fullPath, content: '', matchType: 'none', missReason, directProbe };
}

/**
 * What a directory scan saw, so the caller can name the miss.
 *
 * `entries`/`candidates` are counts, not data: they separate "the folder was
 * empty or unreadable" from "the folder had files but none were candidates"
 * from "candidate files existed but none were ours".
 */
interface ScanResult {
  hit: FileLookupResult | null;
  entries: number;
  candidates: number;
}

/** No scan was possible (no directory to list). */
const NO_SCAN: ScanResult = { hit: null, entries: 0, candidates: 0 };

/** Name the negative a completed scan represents. */
function scanMissReason(scan: ScanResult, budget: ScanBudget): LookupMissReason {
  if (budget.exhausted) return 'budget-exhausted';
  if (scan.entries === 0) return 'empty-directory';
  if (scan.candidates === 0) return 'no-candidate-file';
  return 'candidate-id-mismatch';
}

/**
 * How a directory scan picks and orders the files it is willing to open.
 *
 * In every case the frontmatter id comparison performed by the scan is what
 * actually decides a match; this only avoids — and orders — reads.
 */
interface CandidateScan {
  /** Pre-filter: directory entries that could possibly be our note. */
  matches: (entry: string) => boolean;
  /** Order one directory's candidates before reading them. */
  order: (entries: string[]) => string[];
  /** Match type to report on a hit. */
  matchType: 'id-scan' | 'frontmatter-scan';
}

/** Candidates in listing order; nothing to rank them by. */
const LISTING_ORDER = (entries: string[]): string[] => entries;

/**
 * Decide how to scan for the conversation's existing note.
 *
 * Three shapes, by what the file name itself can narrow:
 *
 * - `title-id` WITH an `-{idPrefix}.md` suffix — still produced for legacy and
 *   pre-migration notes. The suffix narrows the candidate set to (usually) a
 *   single file, so this is the cheap path: one listing plus a read or two.
 * - `title-id` with NO suffix — what human-readable file names always look
 *   like. Nothing in the name carries conversation identity, so every markdown
 *   file is a candidate and only frontmatter can decide. Returning "no scan is
 *   possible" here (as this did before human-readable names existed) is what
 *   made a retitled or migrated note unfindable and forked a duplicate on every
 *   save, so instead the candidates are ranked by title plausibility — see
 *   {@link rankByTitlePlausibility} — and read until the shared
 *   {@link ScanBudget} runs out.
 * - `title` — suffix-less by construction, so the same situation as the
 *   `title-id` no-suffix case: nothing in the name narrows the scan. It takes
 *   the every-note branch explicitly rather than relying on a note's name
 *   happening to carry no id suffix.
 * - `title-date` — names end in the SAVE date, so a note written on the 3rd and
 *   re-saved on the 10th shares no file-name component beyond the title slug;
 *   every markdown file must be considered, in listing order as before.
 */
function createCandidateScan(note: ObsidianNote, scheme: FilenameScheme): CandidateScan {
  const everyNote = (entry: string): boolean => entry.endsWith('.md');
  if (scheme === 'title-date') {
    return { matches: everyNote, order: LISTING_ORDER, matchType: 'id-scan' };
  }
  if (scheme === 'title') {
    const { title } = note.frontmatter;
    return {
      matches: everyNote,
      order: entries => rankByTitlePlausibility(entries, title),
      matchType: 'frontmatter-scan',
    };
  }

  const idSuffix = extractIdSuffix(note.fileName);
  if (idSuffix) {
    return {
      matches: entry => entry.endsWith(`-${idSuffix}.md`),
      order: LISTING_ORDER,
      matchType: 'id-scan',
    };
  }

  const { title } = note.frontmatter;
  return {
    matches: everyNote,
    order: entries => rankByTitlePlausibility(entries, title),
    matchType: 'frontmatter-scan',
  };
}

/**
 * Read a candidate file and return a match result when its frontmatter id is
 * the one we are looking for. Returns null on a budget miss, a missing file, or
 * a different conversation.
 */
async function readCandidate(
  client: ObsidianApiClient,
  candidatePath: string,
  expectedId: string,
  budget: ScanBudget,
  matchType: CandidateScan['matchType']
): Promise<FileLookupResult | null> {
  if (!budget.spend()) return null;
  const content = await client.getFile(candidatePath);
  if (!isSameConversation(classifyNoteProbe(content, expectedId))) return null;
  return { found: true, path: candidatePath, content: content as string, matchType };
}

/**
 * Lowercase word tokens of a title or file-name stem, for plausibility ranking
 * only — never for correctness. `.md` is stripped so a file name and a title
 * tokenize the same way.
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
 * Order scan candidates by how many word-tokens their file name shares with the
 * note's current title, most-plausible first (ties keep directory-listing
 * order). An edited title still shares most of its words with the old one, so
 * this makes a real match likely to land near the front of a budget-capped
 * scan — which matters: a single platform folder holds notes in the thousands,
 * and the budget reads far fewer than that. It is a ranking heuristic only;
 * every candidate opened is still verified against frontmatter id by
 * {@link readCandidate} before it is accepted.
 */
function rankByTitlePlausibility(entries: string[], title: string): string[] {
  const targetTokens = titleTokens(title);
  if (targetTokens.size === 0) return entries;

  return entries
    .map((entry, index) => {
      let shared = 0;
      for (const token of titleTokens(entry)) {
        if (targetTokens.has(token)) shared++;
      }
      return { entry, index, shared };
    })
    .sort((a, b) => b.shared - a.shared || a.index - b.index)
    .map(ranked => ranked.entry);
}

/**
 * Step 0 of {@link lookupExistingFile}: try the caller-memoized path.
 * The id is re-verified because the memo may be stale.
 */
async function tryHintPath(
  client: ObsidianApiClient,
  hintPath: string | undefined,
  fullPath: string,
  expectedId: string
): Promise<FileLookupResult | null> {
  if (!hintPath || hintPath === fullPath) return null;
  const content = await client.getFile(hintPath);
  if (!isSameConversation(classifyNoteProbe(content, expectedId))) return null;
  return { found: true, path: hintPath, content: content as string, matchType: 'memo' };
}

/**
 * Look up an existing file for a conversation.
 *
 * Strategy (ordered by cost):
 * 0. Caller-memoized {@link LookupOptions.hintPath}: GET → verify frontmatter id
 * 1. Direct path: GET fullPath → verify frontmatter id
 * 2. Directory scan, over the candidates {@link createCandidateScan} allows and
 *    in the order it prefers — a suffix-narrowed read for a `-{idSuffix}.md`
 *    name, every markdown file ranked by title plausibility for a
 *    human-readable one — and bounded by one shared {@link ScanBudget}:
 *    2a. flat: listFiles(resolvedPath)
 *    2b. recursive: when {@link LookupOptions.searchBasePath} differs from
 *        resolvedPath (i.e. the vault-path template contains date variables),
 *        walk subdirectories from searchBasePath. This lets append-mode find a
 *        previous-month file even when the current resolved path points at a
 *        not-yet-existing folder.
 * 3. Not found, with {@link LookupMissReason} naming which negative occurred
 *
 * The scan is what keeps a note findable after the two things that move it
 * without changing its frontmatter id: a retitled conversation and a calendar
 * rollover.
 */
export async function lookupExistingFile(
  client: ObsidianApiClient,
  fullPath: string,
  resolvedPath: string,
  note: ObsidianNote,
  options: LookupOptions = {}
): Promise<FileLookupResult> {
  const { searchBasePath = resolvedPath, hintPath, filenameScheme = 'title-id' } = options;
  const expectedId = note.frontmatter.id;

  // Step 0: Caller-memoized hint
  const memoHit = await tryHintPath(client, hintPath, fullPath, expectedId);
  if (memoHit) return memoHit;

  // Step 1: Direct path match
  const directContent = await client.getFile(fullPath);
  const directProbe = classifyNoteProbe(directContent, expectedId);
  if (isSameConversation(directProbe)) {
    return {
      found: true,
      path: fullPath,
      content: directContent as string,
      matchType: 'direct',
      directProbe,
    };
  }

  // Step 2: Directory scan, bounded by a shared request budget
  const candidates = createCandidateScan(note, filenameScheme);
  const budget = createScanBudget(SCAN_MAX_REQUESTS);
  const useRecursive = searchBasePath !== resolvedPath && searchBasePath !== '';

  const scan = useRecursive
    ? await recursiveScan(client, searchBasePath, candidates, expectedId, fullPath, budget)
    : resolvedPath
      ? await flatScan(client, resolvedPath, candidates, expectedId, fullPath, budget)
      : NO_SCAN;
  if (scan.hit) return { ...scan.hit, directProbe };

  // Step 3: Not found
  return notFound(fullPath, scanMissReason(scan, budget), directProbe);
}

/**
 * Scan a single directory for a candidate file (per {@link CandidateScan})
 * whose frontmatter id equals expectedId. Returns the first match, or null.
 *
 * Non-recursive sibling of {@link recursiveScan}, used when the vault path
 * template has no date variables (legacy flat-scan behaviour).
 */
async function flatScan(
  client: ObsidianApiClient,
  dir: string,
  scan: CandidateScan,
  expectedId: string,
  skipPath: string,
  budget: ScanBudget
): Promise<ScanResult> {
  if (!budget.spend()) return NO_SCAN;
  const files = await client.listFiles(dir);
  let candidates = 0;

  for (const file of scan.order(files.filter(scan.matches))) {
    if (budget.exhausted) break;
    const candidatePath = `${dir}/${file}`;
    if (candidatePath === skipPath) continue; // Already checked as direct match
    candidates++;
    const hit = await readCandidate(client, candidatePath, expectedId, budget, scan.matchType);
    if (hit) return { hit, entries: files.length, candidates };
  }

  return { hit: null, entries: files.length, candidates };
}

/**
 * Walk subdirectories from baseDir up to {@link RECURSIVE_SCAN_MAX_DEPTH},
 * looking for a candidate file (per {@link CandidateScan}) whose frontmatter id
 * equals expectedId. Returns the first match, or null when exhausted.
 *
 * Depth is bounded by RECURSIVE_SCAN_MAX_DEPTH; total request count is bounded
 * by the shared {@link ScanBudget}, since breadth is not otherwise limited.
 * Ranking is applied per directory listing rather than across the whole walk,
 * so the cheap case (a flat platform folder) ranks globally and the recursive
 * case keeps streaming instead of buffering every name in the subtree.
 */
async function recursiveScan(
  client: ObsidianApiClient,
  baseDir: string,
  scan: CandidateScan,
  expectedId: string,
  skipPath: string,
  budget: ScanBudget
): Promise<ScanResult> {
  type Frame = { dir: string; depth: number };
  const queue: Frame[] = [{ dir: baseDir, depth: 0 }];
  let seen = 0;
  let candidates = 0;

  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as Frame;
    if (!budget.spend()) return { hit: null, entries: seen, candidates };
    const entries = await client.listEntries(dir);
    seen += entries.length;

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith('/')) {
        if (depth + 1 <= RECURSIVE_SCAN_MAX_DEPTH) {
          const subdir = entry.slice(0, -1);
          queue.push({ dir: `${dir}/${subdir}`, depth: depth + 1 });
        }
        continue;
      }
      if (scan.matches(entry)) files.push(entry);
    }

    for (const entry of scan.order(files)) {
      if (budget.exhausted) break;
      const candidatePath = `${dir}/${entry}`;
      if (candidatePath === skipPath) continue;
      candidates++;
      const hit = await readCandidate(client, candidatePath, expectedId, budget, scan.matchType);
      if (hit) return { hit, entries: seen, candidates };
    }
  }

  return { hit: null, entries: seen, candidates };
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

  // A body that ends inside a fenced code block hides every message after the
  // opening fence, so the count can be wrong while every other signal stays
  // clean: an overcount returns null below and the caller reports a successful
  // no-op. Name the condition rather than letting it vanish (ADR-029, and the
  // same reasoning as the append-lookup miss log in ADR-025).
  const openFence = unterminatedFence(parsed.body);
  if (openFence) {
    console.info('[G2O] Existing note body ends inside a fenced code block', {
      id: note.frontmatter.id,
      fence: openFence,
      countedMessages: existingCount,
      expectedMessages: note.frontmatter.message_count,
    });
  }

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
  //
  // Everything above works on the LF-normalised forms parseFrontmatter returns,
  // and the result stays LF here. The file's own ending is restored by the
  // caller as the last step before the write, so that any body transform it
  // still applies also sees LF (ADR-026). An append must add to the file, not
  // rewrite every line of it (#365).
  const content = updatedRaw + '\n' + parsed.body + '\n\n' + newMessages;

  return {
    content,
    messagesAppended: newTotal - existingCount,
    eol: parsed.eol,
  };
}
