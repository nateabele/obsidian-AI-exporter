/**
 * ChatGPT backfill adapter.
 *
 * Unlike Claude (page cookies alone authenticate the request), ChatGPT's
 * `backend-api` endpoints require a bearer token read from
 * `/api/auth/session` (`accessToken`), sent as `Authorization: Bearer` on
 * every subsequent call, in addition to the page's cookies
 * (`credentials: 'include'`).
 *
 * `/backend-api/conversations` is a genuinely paginated envelope
 * (`{items, total, limit, offset}`), unlike Claude's listing endpoint
 * (which sometimes ignores its own paging parameters). The loop below
 * pages until `total` items are collected, but never trusts `total`
 * blindly: if a page stops yielding new ids before `total` is reached, the
 * listing is incomplete and that must surface as an error rather than a
 * quietly truncated success.
 */

import type { ArchiveAdapter, ArchiveEntry, ArchivedConversation, ArchivedMessage } from './types';
import { walkFromLeaf } from './walk';

const PAGE_SIZE = 100;

interface ChatGptSession {
  accessToken: string;
}

interface ChatGptConversationSummary {
  id: string;
  title: string;
  create_time: number | string;
  update_time?: number | string;
  is_temporary_chat?: boolean;
}

interface ChatGptListEnvelope {
  items: ChatGptConversationSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * `parts` is optional on purpose: only the text-bearing content types
 * (`text`, `multimodal_text`) carry it. A `code` node (every
 * code-interpreter / python tool call) carries `language`/`text` instead,
 * and a `thoughts` node (every reasoning-model turn) carries `thoughts` —
 * both authored by `assistant`, both with no `parts` at all.
 */
interface ChatGptMessage {
  id: string;
  author: { role: string };
  content: { content_type: string; parts?: unknown[] };
}

interface ChatGptNode {
  id: string;
  parent: string | null;
  children: string[];
  message: ChatGptMessage | null;
}

interface ChatGptConversationDetail {
  title: string;
  create_time: number | string;
  current_node: string;
  mapping: Record<string, ChatGptNode>;
  is_temporary_chat?: boolean;
}

/** Raised when a ChatGPT timestamp is neither epoch seconds nor a parseable date string. */
class ChatGptTimestampError extends Error {
  constructor(value: unknown) {
    super(`Unrecognized ChatGPT timestamp: ${JSON.stringify(value) ?? String(value)}`);
    this.name = 'ChatGptTimestampError';
  }
}

/**
 * Normalizes a ChatGPT timestamp to an ISO string. The two endpoints disagree:
 * `/backend-api/conversations` (list) now returns ISO strings, while
 * `/backend-api/conversation/<id>` (detail) still returns epoch seconds.
 * Both forms are accepted deliberately so neither endpoint's format can break
 * the other (`string * 1000` is NaN, and `toISOString()` then throws).
 */
function toIsoTimestamp(value: unknown): string {
  // Round to whole milliseconds: seconds * 1000 can land a hair under the
  // intended millisecond (1673037595.742 * 1000), which toISOString truncates.
  const date =
    typeof value === 'number' && Number.isFinite(value)
      ? new Date(Math.round(value * 1000))
      : typeof value === 'string' && value.trim() !== ''
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new ChatGptTimestampError(value);
  }
  return date.toISOString();
}

async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { credentials: 'include', headers });
  if (!res.ok) {
    throw new Error(`ChatGPT API request failed (${res.status}): ${url}`);
  }
  return res.json() as Promise<T>;
}

function sessionUrl(): string {
  return 'https://chatgpt.com/api/auth/session';
}

function conversationListUrl(offset: number, limit: number): string {
  return `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}`;
}

function conversationDetailUrl(conversationId: string): string {
  return `https://chatgpt.com/backend-api/conversation/${conversationId}`;
}

/**
 * Pages `/backend-api/conversations` until `total` items are collected.
 * Guards against a wrong or missing `total`: a page that yields no new ids
 * ends the loop immediately (rather than spinning), and if fewer items
 * were collected than the server reported, that is thrown rather than
 * returned — a truncated listing must never look like success.
 */
async function fetchConversationList(token: string): Promise<ChatGptConversationSummary[]> {
  const items: ChatGptConversationSummary[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total: number | null = null;

  for (;;) {
    const page = await fetchJson<ChatGptListEnvelope>(
      conversationListUrl(offset, PAGE_SIZE),
      token
    );
    total = typeof page.total === 'number' ? page.total : total;

    const newItems = page.items.filter(item => !seen.has(item.id));
    if (newItems.length === 0) {
      break;
    }
    for (const item of newItems) {
      seen.add(item.id);
      items.push(item);
    }
    offset += page.items.length;

    if (typeof total === 'number' && items.length >= total) {
      break;
    }
  }

  if (typeof total !== 'number' || items.length < total) {
    throw new Error(
      `ChatGPT conversation listing incomplete: got ${items.length} of ${
        total ?? 'an unknown number of'
      } reported conversations`
    );
  }
  return items;
}

/**
 * The transcript text of one message node, or `null` when the node carries
 * no transcript text at all and must be dropped from the chain.
 *
 * Reading `content.parts` unconditionally used to throw
 * (`Cannot read properties of undefined (reading 'filter')`) on every
 * `content_type: 'code'` (code-interpreter call) and `'thoughts'`
 * (reasoning turn) node, which the `author.role` filter above cannot catch
 * because their role genuinely is `'assistant'`.
 *
 * Those nodes are SKIPPED rather than rendered. The live DOM sync does not
 * capture ChatGPT's collapsed reasoning/analysis panels either, so emitting
 * them here would make the two producers disagree message-for-message —
 * exactly the drift the shared hash formula (`to-request.ts`) exists to
 * prevent — and each one would be an extra, unmatchable block in the note.
 */
function transcriptMarkdown(content: ChatGptMessage['content']): string | null {
  const parts = content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }
  return parts.filter((part): part is string => typeof part === 'string').join('\n\n');
}

export class ChatGptArchiveAdapter implements ArchiveAdapter {
  readonly platform = 'chatgpt' as const;

  private async getAccessToken(): Promise<string> {
    const session = await fetchJson<ChatGptSession>(sessionUrl());
    if (!session.accessToken) {
      throw new Error('ChatGPT session response is missing accessToken');
    }
    return session.accessToken;
  }

  async listConversations(): Promise<ArchiveEntry[]> {
    const token = await this.getAccessToken();
    const summaries = await fetchConversationList(token);
    return summaries
      .filter(conv => !conv.is_temporary_chat)
      .flatMap((conv): ArchiveEntry[] => {
        let createdAt: string;
        try {
          createdAt = toIsoTimestamp(conv.create_time);
        } catch {
          // One malformed entry must not discard the whole history.
          console.warn(
            '[G2O] Skipping conversation with unreadable create_time',
            conv.id,
            conv.create_time
          );
          return [];
        }
        return [
          {
            conversationId: conv.id,
            title: conv.title,
            createdAt,
            url: `https://chatgpt.com/c/${conv.id}`,
            // ChatGPT exposes no organization/account concept in this flow
            // (unlike Claude, which can span multiple orgs) — both fields are
            // set explicitly to null rather than omitted, so a future reader
            // doesn't mistake the absence for an oversight.
            accountId: null,
            accountName: null,
          },
        ];
      });
  }

  async fetchConversation(entry: ArchiveEntry): Promise<ArchivedConversation> {
    const token = await this.getAccessToken();
    const detail = await fetchJson<ChatGptConversationDetail>(
      conversationDetailUrl(entry.conversationId),
      token
    );

    const nodes = new Map(Object.entries(detail.mapping));
    const chain = walkFromLeaf(nodes, detail.current_node, n => n.parent);
    const messages: ArchivedMessage[] = chain.flatMap((node): ArchivedMessage[] => {
      const message = node.message;
      if (!message) {
        // The tree root carries no message.
        return [];
      }
      const role =
        message.author.role === 'user'
          ? 'user'
          : message.author.role === 'assistant'
            ? 'assistant'
            : null;
      if (!role) {
        return [];
      }
      const markdown = transcriptMarkdown(message.content);
      if (markdown === null) {
        // A code-interpreter or reasoning node — see transcriptMarkdown().
        return [];
      }
      return [{ role, markdown, sourceId: node.id }];
    });

    return {
      platform: 'chatgpt',
      conversationId: entry.conversationId,
      title: entry.title,
      url: entry.url,
      createdAt: entry.createdAt,
      messages,
      accountId: null,
      accountName: null,
    };
  }
}
