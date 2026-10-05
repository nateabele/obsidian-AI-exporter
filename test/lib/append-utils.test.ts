import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractIdSuffix,
  lookupExistingFile,
  buildAppendContent,
} from '../../src/lib/append-utils';
import type { ObsidianNote, ExtensionSettings, NoteFrontmatter } from '../../src/lib/types';
import { SCAN_MAX_REQUESTS } from '../../src/lib/constants';
import { applyLineEnding } from '../../src/lib/frontmatter-parser';

// ========== extractIdSuffix ==========

describe('extractIdSuffix', () => {
  it('extracts ID suffix from standard filename', () => {
    expect(extractIdSuffix('my-chat-abc12345.md')).toBe('abc12345');
  });

  it('extracts suffix from filename with multiple hyphens', () => {
    expect(extractIdSuffix('this-is-a-long-title-xyz99.md')).toBe('xyz99');
  });

  it('returns empty string for filename without hyphens', () => {
    expect(extractIdSuffix('conversation.md')).toBe('');
  });

  it('handles filename without .md extension', () => {
    expect(extractIdSuffix('test-abc')).toBe('abc');
  });

  it('extracts from simple two-part filename', () => {
    expect(extractIdSuffix('hello-world.md')).toBe('world');
  });
});

// ========== lookupExistingFile ==========

describe('lookupExistingFile', () => {
  let mockClient: {
    getFile: ReturnType<typeof vi.fn>;
    listFiles: ReturnType<typeof vi.fn>;
    listEntries: ReturnType<typeof vi.fn>;
  };
  let testNote: ObsidianNote;

  beforeEach(() => {
    mockClient = {
      getFile: vi.fn(),
      listFiles: vi.fn(),
      listEntries: vi.fn(),
    };

    testNote = createTestNote({
      fileName: 'my-chat-abc12345.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });
  });

  it('returns direct match when file exists at exact path with matching ID', async () => {
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';
    mockClient.getFile.mockResolvedValue(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('direct');
    expect(result.content).toBe(existingContent);
  });

  it('returns not found when direct path has different ID', async () => {
    mockClient.getFile.mockResolvedValueOnce('---\nid: different_id\n---\nBody');
    mockClient.listFiles.mockResolvedValue([]);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.matchType).toBe('none');
  });

  it('falls back to ID scan when direct path does not exist', async () => {
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['old-title-abc12345.md', 'other-file.md']);
    mockClient.getFile.mockResolvedValueOnce(existingContent); // ID scan match

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('id-scan');
    expect(result.path).toBe('AI/claude/old-title-abc12345.md');
  });

  it('returns not found when no files match ID suffix', async () => {
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue(['unrelated-file.md']);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.matchType).toBe('none');
  });

  it('returns not found when directory listing is empty', async () => {
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue([]);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
  });

  it('skips direct path in ID scan to avoid double check', async () => {
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['my-chat-abc12345.md']); // same filename

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    // Should not call getFile again for the same path
    expect(mockClient.getFile).toHaveBeenCalledTimes(1);
    expect(result.found).toBe(false);
  });

  it('handles ID scan with multiple suffix matches, uses first valid', async () => {
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['wrong-id-abc12345.md', 'correct-abc12345.md']);
    mockClient.getFile
      .mockResolvedValueOnce('---\nid: wrong_id\n---\nBody') // first scan miss
      .mockResolvedValueOnce('---\nid: claude_abc-def-123\n---\nBody'); // second scan hit

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(true);
    expect(result.path).toBe('AI/claude/correct-abc12345.md');
  });

  // ----- Recursive scan when date variables produce a different searchBasePath -----

  it('finds file in a sibling date folder when searchBasePath differs from resolvedPath', async () => {
    // Save target: AI/claude/2026/06/my-chat-abc12345.md (June)
    // Existing file lives in AI/claude/2026/05/old-title-abc12345.md (May)
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';

    // Direct path miss (June folder doesn't have it yet)
    mockClient.getFile.mockResolvedValueOnce(null);
    // listEntries from searchBasePath (AI/claude) returns the year folder
    mockClient.listEntries.mockResolvedValueOnce(['2026/']);
    // listEntries from AI/claude/2026 returns month folders
    mockClient.listEntries.mockResolvedValueOnce(['05/', '06/']);
    // listEntries from AI/claude/2026/05 returns the file
    mockClient.listEntries.mockResolvedValueOnce(['old-title-abc12345.md', 'unrelated.md']);
    // listEntries from AI/claude/2026/06 returns empty (current month, file not yet there)
    mockClient.listEntries.mockResolvedValueOnce([]);
    // getFile for the matched candidate
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/2026/06/my-chat-abc12345.md', // resolvedPath = full path with date
      'AI/claude/2026/06', // resolvedPath dir
      testNote,
      { searchBasePath: 'AI/claude' } // template stripped of date variables
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('id-scan');
    expect(result.path).toBe('AI/claude/2026/05/old-title-abc12345.md');
  });

  it('falls back to current-folder ID scan when searchBasePath equals resolvedPath', async () => {
    // No date variables — searchBasePath === resolvedPath
    // Should NOT call listEntries at all (only listFiles, like current behavior)
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';
    mockClient.getFile.mockResolvedValueOnce(null);
    mockClient.listFiles.mockResolvedValueOnce(['old-title-abc12345.md']);
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote,
      { searchBasePath: 'AI/claude' } // identical to resolvedPath
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('id-scan');
    expect(mockClient.listEntries).not.toHaveBeenCalled();
  });

  it('returns not found when recursive scan exhausts all subdirectories', async () => {
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listEntries.mockResolvedValueOnce(['2025/']);
    mockClient.listEntries.mockResolvedValueOnce(['12/']);
    mockClient.listEntries.mockResolvedValueOnce(['unrelated.md']); // no ID match

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/2026/06/my-chat-abc12345.md',
      'AI/claude/2026/06',
      testNote,
      { searchBasePath: 'AI/claude' }
    );

    expect(result.found).toBe(false);
    expect(result.matchType).toBe('none');
  });

  it('skips the direct fullPath candidate during recursive scan', async () => {
    // The recursive scan must not double-fetch the same file already checked at step 1.
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss for fullPath
    mockClient.listEntries.mockResolvedValueOnce(['2026/']);
    mockClient.listEntries.mockResolvedValueOnce(['06/']);
    // Only the same filename at the same path appears
    mockClient.listEntries.mockResolvedValueOnce(['my-chat-abc12345.md']);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/2026/06/my-chat-abc12345.md',
      'AI/claude/2026/06',
      testNote,
      { searchBasePath: 'AI/claude' }
    );

    // getFile must have been called exactly once (the direct check at step 1).
    expect(mockClient.getFile).toHaveBeenCalledTimes(1);
    expect(result.found).toBe(false);
  });

  // ----- filenameScheme: 'title-date' -----
  // The file name embeds the SAVE date, not the conversation id, so a note
  // re-saved on a later day has neither a matching direct path nor a usable
  // id suffix. Without a scheme-aware scan every day produces a duplicate note.

  it('finds a file saved on an earlier day when the scheme is title-date', async () => {
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';
    const dateNote = createTestNote({
      fileName: 'my-chat-2026-07-10.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss: today's name
    mockClient.listFiles.mockResolvedValue(['my-chat-2026-07-03.md', 'unrelated-2026-07-05.md']);
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-2026-07-10.md',
      'AI/claude',
      dateNote,
      { filenameScheme: 'title-date' }
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('id-scan');
    expect(result.path).toBe('AI/claude/my-chat-2026-07-03.md');
  });

  it('does not match a foreign conversation when the scheme is title-date', async () => {
    const dateNote = createTestNote({
      fileName: 'my-chat-2026-07-10.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['someone-elses-2026-07-03.md']);
    mockClient.getFile.mockResolvedValueOnce('---\nid: claude_other-id\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-2026-07-10.md',
      'AI/claude',
      dateNote,
      { filenameScheme: 'title-date' }
    );

    expect(result.found).toBe(false);
    expect(result.matchType).toBe('none');
  });

  // ----- filenameScheme: 'title' -----
  // A suffix-less name gives the scan nothing to narrow on. A hyphenated title
  // such as `Some-Title.md` even LOOKS like it has an id suffix ("Title"), which
  // would narrow the scan to entries ending `-Title.md` and miss the real note.

  it("scans every note when the scheme is 'title', even for a hyphen-lookalike name", async () => {
    const titleNote = createTestNote({
      fileName: 'Some-Title.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123', title: 'Some-Title' }),
    });

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['Retitled note.md', 'Another.md']);
    mockClient.getFile.mockResolvedValueOnce('---\nid: claude_abc-def-123\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/Some-Title.md',
      'AI/claude',
      titleNote,
      { filenameScheme: 'title' }
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('frontmatter-scan');
    expect(result.path).toBe('AI/claude/Retitled note.md');
  });

  it("still narrows by id suffix for 'title-id' (unchanged)", async () => {
    const idNote = createTestNote({
      fileName: 'Some-Title.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123', title: 'Some-Title' }),
    });

    mockClient.getFile.mockResolvedValueOnce(null);
    mockClient.listFiles.mockResolvedValue(['Retitled note.md']);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/Some-Title.md',
      'AI/claude',
      idNote,
      { filenameScheme: 'title-id' }
    );

    expect(result.found).toBe(false);
    expect(mockClient.getFile).toHaveBeenCalledTimes(1); // only the direct probe
  });

  it('finds a title-date file in a previous month folder (recursive scan)', async () => {
    const existingContent = '---\nid: claude_abc-def-123\n---\nBody';
    const dateNote = createTestNote({
      fileName: 'my-chat-2026-07-10.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listEntries.mockResolvedValueOnce(['2026/']);
    mockClient.listEntries.mockResolvedValueOnce(['06/', '07/']);
    mockClient.listEntries.mockResolvedValueOnce(['my-chat-2026-06-28.md']); // June
    mockClient.listEntries.mockResolvedValueOnce([]); // July, still empty
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/2026/07/my-chat-2026-07-10.md',
      'AI/claude/2026/07',
      dateNote,
      { searchBasePath: 'AI/claude', filenameScheme: 'title-date' }
    );

    expect(result.found).toBe(true);
    expect(result.path).toBe('AI/claude/2026/06/my-chat-2026-06-28.md');
  });

  // ----- Human-readable (suffix-less) file names -----
  //
  // `title-id` names no longer carry an `-{idPrefix}` suffix: identity lives in
  // frontmatter, not in the file name. So nothing in the name narrows the
  // candidate set, and the lookup has to verify frontmatter directly (reported
  // as matchType 'frontmatter-scan'). Giving up instead — which is what a
  // suffix-only scan did — made every migrated note unfindable and forked a
  // duplicate note per conversation touched.

  it('still narrows by id suffix and never opens every file when the filename has a suffix', async () => {
    // Cheap path regression guard: with a suffix present, only the suffix-matching
    // file should ever be opened, even when the folder has many other candidates.
    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue([
      'unrelated-one.md',
      'unrelated-two.md',
      'old-title-abc12345.md', // the only name ending in -abc12345.md
      'unrelated-three.md',
    ]);
    mockClient.getFile.mockResolvedValueOnce('---\nid: claude_abc-def-123\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('id-scan');
    // Direct check + exactly one suffix-matching candidate — never the other 3 files.
    expect(mockClient.getFile).toHaveBeenCalledTimes(2);
  });

  it('finds an existing note by frontmatter id when the filename has no id suffix', async () => {
    const unsuffixedNote = createTestNote({ fileName: 'Test Conversation.md' });
    const existingContent = '---\nid: claude_test-id\n---\nBody';

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue([
      'Unrelated Note.md',
      'Old Test Conversation.md', // pre-retitle name; still shares every title word
      'Another Note.md',
    ]);
    // Ranked first (full title-token overlap), so it's the first (and only) read.
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/Test Conversation.md',
      'AI/claude',
      unsuffixedNote
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('frontmatter-scan');
    expect(result.path).toBe('AI/claude/Old Test Conversation.md');
    expect(mockClient.getFile).toHaveBeenCalledTimes(2);
  });

  it('returns a distinguishable not-found result when no unsuffixed candidate matches', async () => {
    const unsuffixedNote = createTestNote({ fileName: 'Test Conversation.md' });

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(['Some Other Chat.md', 'Yet Another Chat.md']);
    mockClient.getFile.mockResolvedValue('---\nid: not-a-match\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/Test Conversation.md',
      'AI/claude',
      unsuffixedNote
    );

    expect(result.found).toBe(false);
    expect(result.matchType).toBe('none');
    expect(result.missReason).toBe('candidate-id-mismatch');
    // A real (if unsuccessful) scan happened — not a silent skip.
    expect(mockClient.getFile).toHaveBeenCalledTimes(1 + 2);
  });

  it('caps the reads of an unsuffixed scan at the shared request budget', async () => {
    const unsuffixedNote = createTestNote({ fileName: 'Test Conversation.md' });
    // None of these share a title token with "Test Conversation", so ranking leaves
    // them in listing order and every one is an equally-plausible candidate.
    const files = Array.from({ length: SCAN_MAX_REQUESTS + 50 }, (_, i) => `file-${i}.md`);

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss
    mockClient.listFiles.mockResolvedValue(files);
    mockClient.getFile.mockResolvedValue('---\nid: not-a-match\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/Test Conversation.md',
      'AI/claude',
      unsuffixedNote
    );

    expect(result.found).toBe(false);
    expect(result.missReason).toBe('budget-exhausted');
    // The direct-path GET plus at most the budgeted scan requests…
    expect(mockClient.getFile.mock.calls.length).toBeLessThanOrEqual(SCAN_MAX_REQUESTS + 1);
    // …and never the whole folder, which in a real vault runs to thousands.
    expect(mockClient.getFile.mock.calls.length).toBeLessThan(files.length);
  });

  it('finds a retitled note across a date-rollover folder when the filename has no id suffix', async () => {
    // Save target: AI/claude/2026/06/Test Conversation.md (June)
    // Existing file lives in AI/claude/2026/05/Old Title.md (May), retitled since.
    const unsuffixedNote = createTestNote({ fileName: 'Test Conversation.md' });
    const existingContent = '---\nid: claude_test-id\n---\nBody';

    mockClient.getFile.mockResolvedValueOnce(null); // direct miss (June folder)
    mockClient.listEntries.mockResolvedValueOnce(['2026/']);
    mockClient.listEntries.mockResolvedValueOnce(['05/', '06/']);
    mockClient.listEntries.mockResolvedValueOnce(['Old Title.md']); // May folder
    mockClient.listEntries.mockResolvedValueOnce([]); // June folder, empty so far
    mockClient.getFile.mockResolvedValueOnce(existingContent);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/2026/06/Test Conversation.md',
      'AI/claude/2026/06',
      unsuffixedNote,
      { searchBasePath: 'AI/claude' }
    );

    expect(result.found).toBe(true);
    expect(result.matchType).toBe('frontmatter-scan');
    expect(result.path).toBe('AI/claude/2026/05/Old Title.md');
  });

  // ===== miss diagnostics (issue #365) =====
  //
  // When append mode finds nothing, the save path forks a new note. Three
  // rounds of correspondence on #365 failed to pin down which negative had
  // occurred, because every one of them produced the same silent `found:
  // false`. These pin the reason down without changing any behaviour.

  it('scans rather than reporting a suffix-less name as unscannable', async () => {
    // This used to assert the opposite — missReason 'no-candidate-suffix' and
    // listFiles never called — back when a `title-id` name always carried an id
    // suffix. Human-readable names never do, so skipping the scan is precisely
    // what forked a duplicate note per conversation; the miss must now be named
    // by what the scan saw.
    const noSuffix = createTestNote({
      fileName: 'conversation.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue([]);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/conversation.md',
      'AI/claude',
      noSuffix
    );

    expect(result.found).toBe(false);
    expect(mockClient.listFiles).toHaveBeenCalledWith('AI/claude');
    expect(result.missReason).toBe('empty-directory');
  });

  it('reports missReason empty-directory when the listing comes back empty', async () => {
    // listEntries maps a 404 to [] (obsidian-api.ts), so "the folder is gone",
    // "the folder is empty" and "the request failed" are indistinguishable to
    // the scan — worth separating from "the folder had files, none matched".
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue([]);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.missReason).toBe('empty-directory');
  });

  it('reports missReason no-candidate-file when the folder holds no same-suffix file', async () => {
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue(['unrelated-file.md', 'another-note-99999999.md']);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.missReason).toBe('no-candidate-file');
  });

  it('reports missReason candidate-id-mismatch when a same-suffix file holds another conversation', async () => {
    mockClient.listFiles.mockResolvedValue(['other-chat-abc12345.md']);
    mockClient.getFile.mockImplementation((path: string) =>
      Promise.resolve(
        path === 'AI/claude/other-chat-abc12345.md'
          ? '---\nid: claude_someone-else\n---\nBody'
          : null
      )
    );

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.missReason).toBe('candidate-id-mismatch');
  });

  it('records what the direct-path probe saw when it holds a different conversation', async () => {
    mockClient.listFiles.mockResolvedValue([]);
    mockClient.getFile.mockResolvedValue('---\nid: claude_someone-else\n---\nBody');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.directProbe).toEqual({
      state: 'different-id',
      foundId: 'claude_someone-else',
    });
  });

  it('records an empty direct-path file as empty rather than as another conversation', async () => {
    // A 0-byte note is a legitimate 200 with an empty body, not evidence that
    // someone else owns the name.
    mockClient.listFiles.mockResolvedValue([]);
    mockClient.getFile.mockResolvedValue('');

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-abc12345.md',
      'AI/claude',
      testNote
    );

    expect(result.found).toBe(false);
    expect(result.directProbe).toEqual({ state: 'empty' });
  });

  it('stops scanning once the request budget is exhausted', async () => {
    const dateNote = createTestNote({
      fileName: 'my-chat-2026-07-10.md',
      frontmatter: createTestFrontmatter({ id: 'claude_abc-def-123' }),
    });

    // Far more candidates than the budget allows; none of them match.
    const candidates = Array.from(
      { length: SCAN_MAX_REQUESTS + 50 },
      (_, i) => `note-${i}-2026-07-01.md`
    );
    mockClient.getFile.mockResolvedValue(null);
    mockClient.listFiles.mockResolvedValue(candidates);

    const result = await lookupExistingFile(
      mockClient as never,
      'AI/claude/my-chat-2026-07-10.md',
      'AI/claude',
      dateNote,
      { filenameScheme: 'title-date' }
    );

    expect(result.found).toBe(false);
    // The direct-path GET plus at most the budgeted scan requests.
    expect(mockClient.getFile.mock.calls.length).toBeLessThanOrEqual(SCAN_MAX_REQUESTS + 1);
    // …and it must not have walked the whole candidate list.
    expect(mockClient.getFile.mock.calls.length).toBeLessThan(candidates.length);
  });
});

// ========== buildAppendContent ==========

describe('buildAppendContent', () => {
  let testSettings: ExtensionSettings;
  let testNote: ObsidianNote;

  beforeEach(() => {
    testSettings = createTestSettings();
    testNote = createTestNote({
      frontmatter: createTestFrontmatter({ message_count: 4 }),
      body: [
        '> [!QUESTION] User',
        '> Hello',
        '',
        '> [!NOTE] Claude',
        '> Hi there!',
        '',
        '> [!QUESTION] User',
        '> New question',
        '',
        '> [!NOTE] Claude',
        '> New answer',
      ].join('\n'),
    });
  });

  it('returns null when existing content has no frontmatter', () => {
    const result = buildAppendContent('No frontmatter here', testNote, testSettings);
    expect(result).toBeNull();
  });

  // ADR-029 / ADR-025 style: a note whose body ends inside a fenced code block
  // is the one shape that can make the count wrong in a way that produces no
  // other signal — an overcount returns null here and the caller reports a
  // successful no-op. Name it, so a field report is actionable.
  describe('unterminated code fence diagnostic', () => {
    const F3 = '`'.repeat(3);

    function existingWith(bodyLines: readonly string[]): string {
      return [
        '---',
        'id: claude_test',
        'message_count: 2',
        'modified: "2026-01-01"',
        '---',
        ...bodyLines,
      ].join('\n');
    }

    it('reports the open fence when the body ends inside a code block', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const existing = existingWith([
        '> [!QUESTION] User',
        '> Hello',
        '',
        '> [!NOTE] Claude',
        '> Here:',
        '',
        `${F3}markdown`,
        'unterminated',
      ]);

      buildAppendContent(existing, testNote, testSettings);

      expect(info).toHaveBeenCalledWith(
        '[G2O] Existing note body ends inside a fenced code block',
        expect.objectContaining({
          id: testNote.frontmatter.id,
          fence: { char: '`', length: 3 },
        })
      );
      info.mockRestore();
    });

    it('stays quiet when every fence is closed', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const existing = existingWith([
        '> [!QUESTION] User',
        '> Hello',
        '',
        '> [!NOTE] Claude',
        '> Here:',
        '',
        `${F3}markdown`,
        'closed',
        F3,
      ]);

      buildAppendContent(existing, testNote, testSettings);

      expect(info).not.toHaveBeenCalled();
      info.mockRestore();
    });
  });

  it('returns null when existing body has no detectable messages', () => {
    const existing = '---\nid: test\nmessage_count: 2\n---\nJust some text';
    const result = buildAppendContent(existing, testNote, testSettings);
    expect(result).toBeNull();
  });

  it('returns null when new message count is not greater than existing', () => {
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 4',
      'modified: "2026-01-01"',
      '---',
      '> [!QUESTION] User',
      '> Q1',
      '',
      '> [!NOTE] Claude',
      '> A1',
      '',
      '> [!QUESTION] User',
      '> Q2',
      '',
      '> [!NOTE] Claude',
      '> A2',
    ].join('\n');

    // Note has 4 messages, existing has 4 → no new messages
    const result = buildAppendContent(existing, testNote, testSettings);
    expect(result).toBeNull();
  });

  it('appends new messages and updates frontmatter', () => {
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 2',
      'modified: "2026-01-01"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const result = buildAppendContent(existing, testNote, testSettings);

    expect(result).not.toBeNull();
    expect(result!.messagesAppended).toBe(2);
    expect(result!.content).toContain('message_count: 4');
    expect(result!.content).toContain('New question');
    expect(result!.content).toContain('New answer');
    // Preserves existing content
    expect(result!.content).toContain('> Hello');
    expect(result!.content).toContain('> Hi there!');
  });

  // ===== line endings (issue #365) =====
  //
  // An append must not rewrite the line endings of a file the user (or their
  // tooling) maintains as CRLF. Normalising for processing is fine; writing the
  // normalised form back is not — it would touch every line of a file we were
  // only asked to add to.

  it('reports the file CRLF ending instead of restoring it early (#406)', () => {
    // The restore moved to the write site: the caller may still transform the
    // body (callout flattening), and every such transform is written against
    // LF (ADR-026). Restoring here handed flattening lines ending in '\r',
    // whose header pattern then failed to match — dropping the callout label
    // and, with it, the message's visibility to countExistingMessages().
    // The end-to-end guarantee (the written file stays CRLF) is asserted in
    // test/background/index.test.ts, which covers the flatten step too.
    const existingLines = [
      '---',
      'id: claude_test',
      'message_count: 2',
      'modified: "2026-01-01T00:00:00.000Z"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ];
    const existing = existingLines.join('\r\n');

    const result = buildAppendContent(existing, testNote, testSettings);

    expect(result).not.toBeNull();
    expect(result!.messagesAppended).toBe(2);
    // The file's own ending is reported, not applied.
    expect(result!.eol).toBe('\r\n');
    expect(result!.content).not.toContain('\r');
    expect(result!.content).toContain('New question');
    // Applying it reproduces the byte-preservation guarantee of #365.
    const written = applyLineEnding(result!.content, result!.eol);
    expect(written).not.toMatch(/(?<!\r)\n/);
    expect(written).toContain(['> [!QUESTION] User', '> Hello'].join('\r\n'));
  });

  it('keeps an LF file on LF', () => {
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 2',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const result = buildAppendContent(existing, testNote, testSettings);

    expect(result).not.toBeNull();
    expect(result!.content).not.toContain('\r');
  });

  it('updates modified timestamp in frontmatter', () => {
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 2',
      'modified: "2026-01-01T00:00:00.000Z"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const result = buildAppendContent(existing, testNote, testSettings);
    expect(result).not.toBeNull();
    // Should have a new modified date (not the old one)
    expect(result!.content).not.toContain('2026-01-01T00:00:00.000Z');
  });

  it('uses timezone setting for modified timestamp in frontmatter', () => {
    const settingsWithTz = {
      ...testSettings,
      templateOptions: { ...testSettings.templateOptions, timezone: 'Asia/Tokyo' },
    };
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 2',
      'modified: "2026-01-01T00:00:00.000Z"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const result = buildAppendContent(existing, testNote, settingsWithTz);
    expect(result).not.toBeNull();
    // Modified timestamp should have JST offset
    expect(result!.content).toMatch(/modified: .*\+09:00/);
  });

  // ========== Issue #187: Question headers in append mode ==========
  it('preserves `## ` question headers when appending new messages', () => {
    const settingsWithHeaders: ExtensionSettings = {
      ...testSettings,
      templateOptions: {
        ...testSettings.templateOptions,
        includeQuestionHeaders: true,
      },
    };

    // Existing file: 2 messages with their `##` header from a prior sync
    const existing = [
      '---',
      'id: claude_test-id',
      'message_count: 2',
      'modified: "2026-01-01"',
      '---',
      '## Hello',
      '',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    // New note has 4 messages; rebuilt body should also include headers
    const noteWithHeaders: ObsidianNote = {
      ...testNote,
      body: [
        '## Hello',
        '',
        '> [!QUESTION] User',
        '> Hello',
        '',
        '> [!NOTE] Claude',
        '> Hi there!',
        '',
        '## New question',
        '',
        '> [!QUESTION] User',
        '> New question',
        '',
        '> [!NOTE] Claude',
        '> New answer',
      ].join('\n'),
    };

    const result = buildAppendContent(existing, noteWithHeaders, settingsWithHeaders);

    expect(result).not.toBeNull();
    expect(result!.messagesAppended).toBe(2);
    // Header for the new question must be carried into the appended tail
    expect(result!.content).toContain('## New question');
    // Existing header should not be duplicated
    const headerCount = (result!.content.match(/^## Hello$/gm) ?? []).length;
    expect(headerCount).toBe(1);
    // Existing content preserved
    expect(result!.content).toContain('> Hello');
    expect(result!.content).toContain('> Hi there!');
    expect(result!.content).toContain('New answer');
  });

  it('preserves user-added notes in existing body', () => {
    const existing = [
      '---',
      'id: claude_test',
      'message_count: 2',
      'modified: "2026-01-01"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      'My personal note about this conversation',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const result = buildAppendContent(existing, testNote, testSettings);
    expect(result).not.toBeNull();
    expect(result!.content).toContain('My personal note about this conversation');
  });
});

// ========== Test Helpers ==========

function createTestFrontmatter(overrides?: Partial<NoteFrontmatter>): NoteFrontmatter {
  return {
    id: 'claude_test-id',
    title: 'Test Conversation',
    source: 'claude',
    url: 'https://claude.ai/chat/test-id',
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    tags: ['ai-conversation', 'claude'],
    message_count: 2,
    ...overrides,
  };
}

function createTestNote(overrides?: Partial<ObsidianNote>): ObsidianNote {
  return {
    fileName: 'test-chat-abc12345.md',
    frontmatter: createTestFrontmatter(),
    body: ['> [!QUESTION] User', '> Hello', '', '> [!NOTE] Claude', '> Hi there!'].join('\n'),
    contentHash: 'testhash',
    ...overrides,
  };
}

function createTestSettings(): ExtensionSettings {
  return {
    obsidianApiKey: 'test-key',
    obsidianUrl: 'http://127.0.0.1:27123',
    vaultPath: 'AI/{platform}',
    templateOptions: {
      includeId: true,
      includeTitle: true,
      includeTags: true,
      includeSource: true,
      includeDates: true,
      includeMessageCount: true,
      messageFormat: 'callout',
      userCalloutType: 'QUESTION',
      assistantCalloutType: 'NOTE',
    },
    outputOptions: {
      obsidian: true,
      file: false,
      clipboard: false,
    },
    enableAutoScroll: false,
    enableAppendMode: true,
  };
}

describe('buildAppendContent — frontmatter tags stay as the user left them (issue #493)', () => {
  it('appends new messages without touching an existing tags block that differs from the setting', () => {
    const existing = [
      '---',
      'id: claude_test-id',
      'tags:',
      '  - my/own-tag',
      '  - hand-edited',
      'message_count: 2',
      'modified: "2026-01-01"',
      '---',
      '> [!QUESTION] User',
      '> Hello',
      '',
      '> [!NOTE] Claude',
      '> Hi there!',
    ].join('\n');

    const note = createTestNote({
      frontmatter: createTestFrontmatter({ tags: ['ai/chat', 'claude'], message_count: 4 }),
      body: [
        '> [!QUESTION] User',
        '> Hello',
        '',
        '> [!NOTE] Claude',
        '> Hi there!',
        '',
        '> [!QUESTION] User',
        '> Second question',
        '',
        '> [!NOTE] Claude',
        '> Second answer',
      ].join('\n'),
    });
    const settings = {
      ...createTestSettings(),
      templateOptions: {
        ...createTestSettings().templateOptions,
        conversationTags: ['ai/chat', '{platform}'],
      },
    };

    const result = buildAppendContent(existing, note, settings);

    expect(result).not.toBeNull();
    expect(result!.messagesAppended).toBe(2);
    expect(result!.content).toContain('tags:\n  - my/own-tag\n  - hand-edited\n');
    expect(result!.content).not.toContain('ai/chat');
    expect(result!.content).toContain('message_count: 4');
    expect(result!.content).toContain('Second answer');
  });
});
