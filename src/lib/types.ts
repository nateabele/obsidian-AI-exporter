/**
 * Shared TypeScript types for Gemini to Obsidian extension
 */

/**
 * Supported AI platform identifiers
 */
export type AIPlatform = 'gemini' | 'claude' | 'perplexity' | 'chatgpt' | 'notebooklm';

/**
 * An image captured from a conversation (e.g. a Gemini-generated image).
 *
 * Image bytes are captured in the content script (blob: URLs are origin- and
 * context-scoped and cannot be fetched from the background service worker), so
 * they travel to the background as base64 over structured-clone message passing.
 */
export interface ExtractedImage {
  /** Stable id, unique within the conversation (e.g. "img-1") */
  readonly id: string;
  /** MIME type, e.g. "image/png" */
  readonly mimeType: string;
  /** Base64-encoded image bytes (no `data:` prefix) */
  readonly data: string;
  /** Alt text from the DOM (e.g. "（AI 生成）") */
  readonly alt: string;
  /** Original blob/URL (diagnostic only; not resolvable outside the page) */
  readonly sourceUrl?: string;
}

/**
 * Represents a single message in a conversation
 */
export interface ConversationMessage {
  /** Unique message identifier */
  id: string;
  /** Message author role */
  role: 'user' | 'assistant';
  /** Message content (plain text for user, may contain HTML for assistant) */
  content: string;
  /** Original HTML content (for assistant messages, used in HTML→Markdown conversion) */
  htmlContent?: string;
  /** Tool-use content (web search, code interpreter) — rendered as separate callout */
  toolContent?: string;
  /** Zero-based message order in conversation */
  index: number;
}

/**
 * Extracted conversation data
 */
export interface ConversationData {
  id: string;
  title: string;
  url: string;
  source: AIPlatform;
  type?: 'conversation' | 'deep-research';
  /** Deep Research link information (optional) */
  links?: DeepResearchLinks;
  messages: ConversationMessage[];
  /** Images captured from the conversation (e.g. Gemini-generated images) */
  images?: ExtractedImage[];
  extractedAt: Date;
  metadata: ConversationMetadata;
  /** Auto-scroll stopped early, so earlier messages may be missing (#449). */
  truncated?: boolean;
  /**
   * Ordinal of the newest turn this extraction covered, on platforms that
   * expose a conversation-wide monotonic ordinal (Claude's `data-index`,
   * ChatGPT's `conversation-turn-N`). Undefined elsewhere.
   *
   * The sync icon compares it against the live DOM to tell "a message newer
   * than the sync has appeared" from "the user scrolled" (issue #465).
   */
  messageWatermark?: number;
}

/**
 * Deep Research source information
 *
 * Design: Sources are stored in DOM order (0-based array).
 * Mapping to data-turn-source-index (1-based):
 *   data-turn-source-index="N" → sources[N-1]
 */
export interface DeepResearchSource {
  /** 0-based array index (DOM order) */
  index: number;
  /** Source URL */
  url: string;
  /** Source title */
  title: string;
  /** Domain name */
  domain: string;
}

/**
 * Deep Research links extraction result
 *
 * Design: Only sources array is stored. Inline citations are processed
 * during HTML→Markdown conversion using data-turn-source-index attribute.
 */
export interface DeepResearchLinks {
  /** Source list (DOM order, 0-based index) */
  sources: DeepResearchSource[];
}

/**
 * Additional metadata about the conversation
 */
export interface ConversationMetadata {
  /** Total number of messages */
  messageCount: number;
  /** Number of user messages */
  userMessageCount: number;
  /** Number of assistant (AI) messages */
  assistantMessageCount: number;
  /** Whether conversation contains code blocks */
  hasCodeBlocks: boolean;
  /** Estimated token count (reserved for future use - not currently calculated) */
  estimatedTokens?: number;
}

/**
 * Obsidian note structure
 */
export interface ObsidianNote {
  fileName: string;
  /**
   * The extraction stopped before reaching the top of the conversation, so
   * this note may be missing earlier messages (issue #449).
   *
   * Structured rather than inferred from `warnings`: a reader that parses the
   * writer's prose is the seam ADR-028 was written about. Never written to
   * frontmatter — it describes this capture, not the conversation.
   */
  truncated?: boolean;
  frontmatter: NoteFrontmatter;
  body: string;
  contentHash: string;
  /**
   * Images referenced by `g2o-image://{id}` placeholders in {@link body}.
   * Resolved per output destination in the background (Obsidian embed,
   * downloaded file, or stripped for clipboard).
   */
  images?: ExtractedImage[];
}

/**
 * YAML frontmatter fields
 */
export interface NoteFrontmatter {
  id: string;
  title: string;
  source: string;
  type?: string;
  url: string;
  created: string;
  modified: string;
  tags: string[];
  message_count: number;
}

/**
 * Output destination identifier
 */
export type OutputDestination = 'obsidian' | 'file' | 'clipboard';

/**
 * Output option settings
 * Manages enabled/disabled state for each output destination
 */
export interface OutputOptions {
  /** Save via Obsidian REST API */
  obsidian: boolean;
  /** Save as file to downloads folder */
  file: boolean;
  /** Copy to system clipboard */
  clipboard: boolean;
}

/**
 * Result of a single output operation
 */
export interface OutputResult {
  destination: OutputDestination;
  success: boolean;
  error?: string;
  /** Number of messages appended (Obsidian append mode only) */
  messagesAppended?: number;
  /**
   * Actual file name used when the intended name was occupied by a
   * DIFFERENT conversation (filename collision safeguard, issue #327).
   */
  savedAs?: string;
  /**
   * Non-fatal problem encountered while writing to this destination
   * (e.g. an image that could not be saved, issue #376). Surfaced to the
   * user as a follow-up warning toast; the output itself still succeeded.
   */
  warning?: string;
}

/**
 * Response from offscreen clipboard write operation
 */
export interface ClipboardWriteResponse {
  success: boolean;
  error?: string;
}

/**
 * Aggregated result of multiple output operations
 */
export interface MultiOutputResponse {
  results: OutputResult[];
  /** Whether all outputs succeeded */
  allSuccessful: boolean;
  /** Whether at least one output succeeded */
  anySuccessful: boolean;
  /** Number of messages appended (append mode only) */
  messagesAppended?: number;
}

/**
 * Secure settings (stored in local storage)
 * Sensitive data like API keys are stored locally, not synced
 */
export interface SecureSettings {
  obsidianApiKey: string;
  /** Bearer token for the Mail API companion listener. Local-only, never synced. */
  companionToken: string;
}

/**
 * Sync settings (stored in sync storage)
 * Non-sensitive data that can be synced across devices
 */
export interface SyncSettings {
  obsidianUrl: string;
  vaultPath: string;
  templateOptions: TemplateOptions;
  outputOptions: OutputOptions;
  /** Enable auto-scroll to load all messages in long conversations (e.g. Gemini) */
  enableAutoScroll: boolean;
  /** Enable append mode to only add new messages to existing notes */
  enableAppendMode: boolean;
  /** Include tool-use / intermediate content (e.g., web search results) */
  enableToolContent: boolean;
  /** Export conversation images (Obsidian vault + file download). */
  enableImageExport: boolean;
  /**
   * Vault-relative folder for exported images. Supports the same template
   * tokens as {@link vaultPath} (`{platform}`, `{YYYY}`, …). Default
   * `AI/{platform}/images`. Obsidian resolves attachments by filename, so the
   * note's wikilink embeds need only the filename regardless of this folder.
   */
  imageVaultPath: string;
  /**
   * Obsidian-only: flatten callouts longer than {@link maxCalloutLines} to
   * plain text when saving to the vault. A very long message rendered as one
   * giant callout can hang Obsidian's renderer; downloaded markdown is
   * unaffected. Default true.
   */
  flattenLargeCallouts: boolean;
  /** Line threshold for {@link flattenLargeCallouts}. Default 200. */
  maxCalloutLines: number;
  /** Base URL of the Mail API companion listener. */
  companionUrl: string;
  /** Platforms on which continuous sync is active. */
  autoSyncPlatforms: AIPlatform[];
  /**
   * Give up auto-scrolling when nothing has progressed for this many seconds.
   * Default 15 (issue #449).
   */
  scrollIdleTimeoutSec: number;
  /** Absolute cap on one auto-scroll pass, in seconds. Default 300. */
  scrollMaxTimeoutSec: number;
  /**
   * Largest note body the background will send to any output, in MiB
   * (issue #467, ADR-038). Clamped to 1–16 by the schema.
   */
  maxNoteSizeMiB: number;
}

/**
 * Extension settings stored in chrome.storage
 * Combined interface merging SecureSettings and SyncSettings
 */
export interface ExtensionSettings extends SecureSettings, SyncSettings {}

/**
 * Settings returned to content scripts (API key redacted)
 *
 * Security: Content scripts run inside third-party pages and should
 * never receive the actual API key. They only need to know whether
 * a key is configured (boolean flag).
 */
export interface ContentScriptSettings extends SyncSettings {
  isApiKeyConfigured: boolean;
  isCompanionConfigured: boolean;
}

/**
 * Note filename naming scheme (issue #328).
 * - `title`      — `{title}.md`, no suffix of any kind (default). Matches the
 *   names mail-api's notePathFor() writes and the vault migration produced.
 * - `title-id`   — historically `{slug}-{conversationId[:8]}.md`; currently
 *   emits the same suffix-less name as `title`
 * - `title-date` — `{slug}-{YYYY}-{MM}-{DD}.md` using the local save date
 */
export type FilenameScheme = 'title' | 'title-id' | 'title-date';

/**
 * Template customization options
 */
export interface TemplateOptions {
  /** Include conversation ID in frontmatter */
  includeId: boolean;
  /** Include title in frontmatter */
  includeTitle: boolean;
  /** Include tags in frontmatter */
  includeTags: boolean;
  /** Include source platform in frontmatter */
  includeSource: boolean;
  /** Include created/modified dates in frontmatter */
  includeDates: boolean;
  /** Include message count in frontmatter */
  includeMessageCount: boolean;
  /** Message formatting style */
  messageFormat: 'callout' | 'plain' | 'blockquote';
  /** Callout type for user messages (e.g., 'QUESTION') */
  userCalloutType: string;
  /** Callout type for assistant messages (e.g., 'NOTE') */
  assistantCalloutType: string;
  /**
   * Prepend an `##` header derived from the user message before each user
   * callout/blockquote/plain block. Enables Obsidian TOC navigation in long
   * conversations. Defaults to false (issue #187).
   */
  includeQuestionHeaders?: boolean;
  /** IANA timezone for created/modified dates (e.g., 'Asia/Tokyo'). Defaults to 'UTC'. */
  timezone?: string;
  /** Note filename naming scheme (issue #328). Defaults to `title-id`. */
  filenameScheme?: FilenameScheme;
  /**
   * Frontmatter tags for conversation notes (issue #493). Entries are literal
   * tags or the `{platform}` token; see `lib/tag-template.ts`. Defaults to
   * `['ai-conversation', '{platform}']`.
   */
  conversationTags?: string[];
  /**
   * Frontmatter tags for Deep Research notes (issue #493). Defaults to
   * `['ai-research', 'deep-research', '{platform}']`.
   */
  deepResearchTags?: string[];
}

/**
 * Message types for chrome.runtime communication
 */
export type ExtensionMessage =
  | { action: 'saveToOutputs'; data: ObsidianNote; outputs: OutputDestination[] }
  | { action: 'getSettings' }
  | { action: 'testConnection' }
  | { action: 'chatSync'; data: ChatSyncRequest }
  | { action: 'chatBackfill'; data: ChatBackfillRequest }
  | { action: 'openInObsidian'; data: { path: string } }
  | { action: 'fetchImage'; url: string };

/**
 * What the background worker answers instead of a real result: an
 * unauthorized sender, a message that failed validation, an unknown action,
 * or a handler that threw (see the listener in service-worker.ts). It carries
 * no `results`, so it must never be read as a {@link MultiOutputResponse}
 * (issue #467).
 */
export interface ErrorResponse {
  success: false;
  error: string;
}

/**
 * Response to a `fetchImage` message. The background worker fetches remote
 * images the content script cannot reach (CORS) and returns them as base64.
 */
export type ImageFetchResponse =
  | { success: true; data: string; mimeType: string; error?: undefined }
  | { success: false; error: string; data?: undefined; mimeType?: undefined };

/**
 * Message sent from the background worker to the offscreen document.
 * Kept separate from ExtensionMessage: the background listener routes
 * `target: 'offscreen'` messages away before validation.
 */
export interface OffscreenClipboardMessage {
  action: 'clipboardWrite';
  target: 'offscreen';
  content: string;
}

/**
 * Response from background service worker
 */
export interface SaveResponse {
  success: boolean;
  error?: string;
  isNewFile?: boolean;
  messagesAppended?: number;
  /** Actual file name when a collision forced an alternative (issue #327) */
  savedAs?: string;
  /**
   * Non-fatal problem encountered while saving — the note itself was written.
   * Currently set when one or more images could not be written (issue #376).
   */
  warning?: string;
}

/**
 * A single new block (message) sent to the Mail API companion listener for
 * continuous sync.
 */
export interface ChatSyncBlock {
  role: 'user' | 'assistant';
  markdown: string;
  hash: string;
}

/**
 * Request body for `POST /api/chat/sync` against the Mail API companion
 * listener (continuous background sync, as opposed to the manual
 * saveToOutputs flow above).
 */
export interface ChatSyncRequest {
  conversationId: string;
  platform: AIPlatform;
  title: string;
  url: string;
  manifest: string[];
  newBlocks: ChatSyncBlock[];
}

/**
 * A suggested related note surfaced by the companion listener (e.g. a prior
 * transcript or topic page that may be relevant to the synced conversation).
 */
export interface ChatSuggestion {
  kind: 'transcript' | 'topic';
  title: string;
  path: string;
}

/**
 * Response from `POST /api/chat/sync`.
 */
export interface ChatSyncResponse {
  notePath: string;
  // 'needsFullContent': the stored blocks were produced by a different
  // producer (e.g. a prior backfill) whose hashes cannot be compared
  // against this manifest — the caller must resend once with `newBlocks`
  // covering every message (see `runAutoSync` in src/content/bootstrap.ts).
  mode: 'noop' | 'append' | 'diverge' | 'needsFullContent';
  appended: number;
  superseded: number;
  suggestions: { transcripts: ChatSuggestion[]; pages: ChatSuggestion[] };
}

/**
 * Outcome of one `flushQueue()` replay cycle (`src/lib/companion-client.ts`).
 * Client-side bookkeeping only — never sent to the companion — so this is
 * free to grow without touching the wire payloads above.
 */
export interface FlushQueueResult {
  /** Requests the companion accepted this cycle; removed from the queue. */
  sent: number;
  /**
   * Requests the companion explicitly refused this cycle: a `noop`
   * response to a non-empty `newBlocks`, the same signal
   * `src/content/bootstrap.ts`'s `sendChatSync` treats as a stall rather
   * than a success (e.g. its Guard 2 rejecting a suspected virtualised
   * window). Still queued unless this refusal exhausted the entry's
   * attempts — see `exhausted`.
   */
  refused: number;
  /** Requests that raised (network error, non-OK status, etc.) rather than resolving with a refusal. Still queued unless exhausted. */
  failed: number;
  /**
   * Entries dropped this cycle after repeated failed-or-refused replays
   * (see `MAX_REPLAY_ATTEMPTS` in `companion-client.ts`). The data those
   * represented is gone for good — always logged loudly when this is
   * non-zero, since nothing else surfaces it.
   */
  exhausted: number;
  /** Queue length remaining after this cycle. */
  remaining: number;
}

/**
 * The companion replay queue's current backlog depth plus the last flush
 * cycle's outcome, for a caller (e.g. the sync icon) that wants to reflect
 * backlog/exhaustion without reaching into `chrome.storage.local` directly.
 * `lastFlush` is `null` until the first flush cycle since the service worker
 * started. Returned by `getQueueStatus()` in `companion-client.ts` — not yet
 * behind a `chrome.runtime` message action (see that function's doc comment
 * for why).
 */
export interface ChatSyncQueueStatus {
  queued: number;
  lastFlush: FlushQueueResult | null;
}

/**
 * A single message within a {@link ChatBackfillRequest}. Unlike
 * `ChatSyncBlock`, carries `sourceId` (the platform's own message id, used
 * server-side for anchor preservation across producers) and an optional
 * `truncated` flag — a conversation containing any truncated message is
 * refused wholesale by the server rather than partially imported.
 */
export interface ChatBackfillMessage {
  role: 'user' | 'assistant';
  markdown: string;
  hash: string;
  sourceId: string;
  truncated?: boolean;
}

/**
 * Request body for `POST /api/chat/backfill` against the Mail API companion
 * listener: an authoritative, whole-conversation import fetched directly
 * from a platform's own API (see `src/content/archive/`), as opposed to
 * `ChatSyncRequest`'s incremental diff of the live DOM. `accountId`/
 * `accountName` are carried straight through from `ArchivedConversation`
 * (`src/content/archive/types.ts`) and may be `null` for a platform
 * (ChatGPT) that exposes no organization in that flow.
 */
export interface ChatBackfillRequest {
  conversationId: string;
  platform: AIPlatform;
  title: string;
  url: string;
  createdAt: string;
  messages: ChatBackfillMessage[];
  accountId: string | null;
  accountName: string | null;
}

/**
 * Response from `POST /api/chat/backfill`. `notePath` and `skipped` are
 * mutually exclusive: `skipped` carries the reason (e.g. `'truncated'`)
 * when the server refuses the whole conversation, with `notePath: null`
 * and nothing written to the vault.
 */
export interface ChatBackfillResponse {
  notePath: string | null;
  anchorsPreserved: number;
  anchorsIssued: number;
  superseded: number;
  skipped: string | null;
}

/**
 * Message sent from the popup directly to the active tab's content script
 * (via `chrome.tabs.sendMessage`), never through the background worker —
 * an archive adapter's fetches (`src/content/archive/`) use
 * `credentials: 'include'` against the platform's own origin, which only
 * carries the user's session cookies from a page ON that origin, so
 * discovery must run in the content script itself. Kept separate from
 * `ExtensionMessage`/`VALID_MESSAGE_ACTIONS`: this channel never reaches
 * the background listener, so it carries none of that whitelist's
 * security-review weight (see test/arch/message-senders.test.ts).
 */
export interface ArchiveDiscoverMessage {
  action: 'archiveDiscover';
}

/**
 * One conversation discovery could not convert to a backfill payload. A
 * single malformed conversation must not cost the user the whole import,
 * so it is reported here — named, with its reason — and skipped, rather
 * than failing the run (see `discoverConversations`).
 */
export interface ArchiveDiscoverFailure {
  conversationId: string;
  title: string;
  error: string;
}

/**
 * Response to {@link ArchiveDiscoverMessage}: every conversation the
 * adapter found, already converted to backfill payloads (see
 * `toBackfillRequest` in `src/content/archive/to-request.ts`) so the popup
 * can hand each one straight to a `'chatBackfill'` message without
 * depending on any content-layer type (ADR-012: popup must not import
 * content/). `failures` is always present (empty when nothing was skipped)
 * so the popup is compiler-forced to surface partial results rather than
 * silently reporting a truncated import as a clean one.
 */
export type ArchiveDiscoverResponse =
  | { success: true; conversations: ChatBackfillRequest[]; failures: ArchiveDiscoverFailure[] }
  | { success: false; error: string };

/**
 * Generic failure shape the background worker sends back when a message
 * handler throws (see the `onMessage` listener in
 * src/background/service-worker.ts). Message actions whose success response
 * has no `success`/`error` fields of its own (e.g. {@link ChatSyncResponse})
 * must union it in so callers are compiler-forced to check for failure
 * instead of reading `undefined` off a success-shaped type.
 */
export interface MessageErrorResponse {
  success: false;
  error: string;
}

/**
 * Extraction result from content script
 */
export interface ExtractionResult {
  success: boolean;
  data?: ConversationData;
  error?: string;
  warnings?: string[];
}

/**
 * Validation result for extraction quality
 */
export interface ValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Interface for AI platform extractors
 */
export interface IConversationExtractor {
  readonly platform: AIPlatform;
  canExtract(): boolean;
  extract(): Promise<ExtractionResult>;
  getConversationId(): string | null;
  getTitle(): string;
  extractMessages(): ConversationMessage[];
  validate(result: ExtractionResult): ValidationResult;
  applySettings(settings: SyncSettings): void;
  /**
   * Highest conversation-wide turn ordinal currently in the DOM, or null when
   * the platform exposes no such ordinal.
   *
   * A *mounted*-window read: on virtualized platforms it drops as turns evict
   * and rises again as they re-mount, so it is only ever meaningful compared
   * against {@link ConversationData.messageWatermark} (issue #465).
   */
  getMessageWatermark(): number | null;
  /**
   * Lowest conversation-wide turn ordinal currently mounted, or null when the
   * platform exposes none. Above 0 means earlier turns are virtualized away,
   * so an extraction taken now is a window rather than the whole conversation.
   */
  getLowestMountedIndex(): number | null;
}
