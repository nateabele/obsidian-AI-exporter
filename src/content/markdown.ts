/**
 * HTML to Markdown conversion — barrel re-export + orchestrator
 *
 * Internal modules:
 * - markdown-rules.ts      — Turndown engine (leaf, no internal deps)
 * - markdown-deep-research.ts — Citation → footnote pipeline
 * - markdown-formatting.ts — Message formatting templates
 */

import { formatMessage, formatToolContent } from './markdown-formatting';
import { convertDeepResearchContent } from './markdown-deep-research';
import { generateHash } from '../lib/hash';
import { MAX_FILENAME_BASE_LENGTH } from '../lib/constants';
import type {
  ConversationData,
  ObsidianNote,
  NoteFrontmatter,
  TemplateOptions,
  FilenameScheme,
} from '../lib/types';
import { formatDateWithTimezone } from '../lib/date-utils';
import { getDateVariables } from '../lib/path-utils';
import {
  DEFAULT_CONVERSATION_TAGS,
  DEFAULT_DEEP_RESEARCH_TAGS,
  resolveTags,
} from '../lib/tag-template';

// Re-exports (preserve existing import paths)
export { htmlToMarkdown, escapeAngleBrackets, escapeUserText } from './markdown-rules';
export { convertDeepResearchContent } from './markdown-deep-research';

/**
 * Characters a filename/Obsidian cannot hold, plus Obsidian's own wikilink
 * syntax (# ^ [ ]), plus control characters. Deliberately excludes the
 * whitespace control characters (\t \n \r \v \f) \u2014 those fall through to the
 * `\s+` collapse in {@link sanitizeFilenameTitle} and become a single
 * ordinary space, rather than being silently deleted, so `"Foo\nBar"` reads
 * as `"Foo Bar"` and not `"FooBar"`. Every character that could turn a title
 * into a *path* (`/`, `\`, `:`) is in this set, so
 * {@link sanitizeFilenameTitle}'s output can never contain a path separator
 * or a drive letter \u2014 that is deliberate, not a side effect of lowercasing
 * the way the scheme this replaces incidentally was.
 *
 * Must stay byte-for-byte in sync with FORBIDDEN_FILENAME_CHARS in
 * mail-api/server/services/chat/chatSyncService.js.
 */
// Stripping control characters from a filename is the point; \t \n \r \v \f
// are deliberately excluded (see above), and \x09-\x0d is exactly that gap.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FILENAME_CHARS = /[/\\:*?"<>|#^[\]\x00-\x08\x0e-\x1f\x7f]/g;

/**
 * Sanitize a conversation title into a human-readable filename base.
 *
 * Preserves case, spaces and non-Latin characters (CJK/Hangul included);
 * strips only what a filename or Obsidian cannot hold; collapses whitespace
 * runs left behind by stripping; trims leading/trailing spaces and dots (a
 * leading dot hides the file, a trailing dot is invalid on some
 * filesystems); truncates to {@link MAX_FILENAME_BASE_LENGTH}; and falls
 * back to `'conversation'` for an empty or fully-stripped title.
 *
 * Must stay byte-for-byte in sync with sanitizeFilenameTitle() in
 * mail-api/server/services/chat/chatSyncService.js \u2014 the extension writes
 * the manual-export filename, mail-api writes the auto-sync filename, and
 * they have to land on the same note or append/lookup silently forks into
 * two files.
 */
function sanitizeFilenameTitle(title: string): string {
  return (
    (title || '')
      .replace(FORBIDDEN_FILENAME_CHARS, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .substring(0, MAX_FILENAME_BASE_LENGTH)
      .replace(/[\s.]+$/g, '') || 'conversation'
  );
}

/**
 * Generate a sanitized note filename from the title, per the chosen scheme.
 *
 * The title is always run through {@link sanitizeFilenameTitle}. The suffix
 * depends on `scheme`:
 * - `title-id`   \u2192 none \u2014 identity is carried by frontmatter, not the
 *   filename (default).
 * - `title-date` \u2192 the local `YYYY-MM-DD` of `date` (save date), matching the
 *   vault-path date tokens.
 *
 * @param title           Conversation title.
 * @param _conversationId Raw conversation id. Unused by the `title-id`
 *   scheme (identity is carried by frontmatter, not the filename \u2014 see
 *   {@link sanitizeFilenameTitle}); kept for signature compatibility.
 * @param scheme          Naming scheme (default `title-id`).
 * @param date            Date for the `title-date` scheme (default: now).
 */
export function generateFileName(
  title: string,
  _conversationId: string,
  scheme: FilenameScheme = 'title-id',
  date: Date = new Date()
): string {
  const slug = sanitizeFilenameTitle(title);

  if (scheme === 'title-date') {
    return `${slug}-${dateSuffix(date)}.md`;
  }
  return `${slug}.md`;
}

/** Local `YYYY-MM-DD` suffix for the `title-date` scheme. */
function dateSuffix(date: Date): string {
  const { YYYY, MM, DD } = getDateVariables(date);
  return `${YYYY}-${MM}-${DD}`;
}

/**
 * Generate content hash for deduplication
 */
export function generateContentHash(content: string): string {
  return generateHash(content);
}

/**
 * Convert conversation data to Obsidian note
 */
export function conversationToNote(data: ConversationData, options: TemplateOptions): ObsidianNote {
  const timezone = options.timezone ?? 'UTC';
  const now = formatDateWithTimezone(new Date(), timezone);

  // Generate frontmatter
  const frontmatter: NoteFrontmatter = {
    id: `${data.source}_${data.id}`,
    title: data.title,
    source: data.source,
    ...(data.type && { type: data.type }),
    url: data.url,
    created: formatDateWithTimezone(data.extractedAt, timezone),
    modified: now,
    tags: resolveTags(
      data.type === 'deep-research'
        ? (options.deepResearchTags ?? DEFAULT_DEEP_RESEARCH_TAGS)
        : (options.conversationTags ?? DEFAULT_CONVERSATION_TAGS),
      data.source
    ),
    message_count: data.messages.length,
  };

  // Generate body - different format for Deep Research vs normal conversation
  let body: string;

  if (data.type === 'deep-research') {
    // Deep Research: convert with links support (footnotes + References)
    if (data.messages.length === 0) {
      body = '';
    } else {
      body = convertDeepResearchContent(data.messages[0].content, data.links);
    }
  } else {
    // Normal conversation format (callout style)
    const bodyParts: string[] = [];

    for (const message of data.messages) {
      // Render tool content as separate collapsible callout before assistant message
      if (message.toolContent) {
        bodyParts.push(formatToolContent(message.toolContent, options));
      }
      const formatted = formatMessage(message.content, message.role, options, data.source);
      bodyParts.push(formatted);
    }

    body = bodyParts.join('\n\n');
  }

  // Generate filename and content hash
  const fileName = generateFileName(data.title, data.id, options.filenameScheme);
  const contentHash = generateContentHash(body);

  return {
    ...(data.truncated ? { truncated: true } : {}),
    fileName,
    frontmatter,
    body,
    contentHash,
    images: data.images ?? [],
  };
}
