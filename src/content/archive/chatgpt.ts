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
  create_time: number;
  is_temporary_chat?: boolean;
}

interface ChatGptListEnvelope {
  items: ChatGptConversationSummary[];
  total: number;
  limit: number;
  offset: number;
}

interface ChatGptMessage {
  id: string;
  author: { role: string };
  content: { content_type: string; parts: unknown[] };
}

interface ChatGptNode {
  id: string;
  parent: string | null;
  children: string[];
  message: ChatGptMessage | null;
}

interface ChatGptConversationDetail {
  title: string;
  create_time: number;
  current_node: string;
  mapping: Record<string, ChatGptNode>;
  is_temporary_chat?: boolean;
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
    const page = await fetchJson<ChatGptListEnvelope>(conversationListUrl(offset, PAGE_SIZE), token);
    total = typeof page.total === 'number' ? page.total : total;

    const newItems = page.items.filter((item) => !seen.has(item.id));
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
      .filter((conv) => !conv.is_temporary_chat)
      .map((conv) => ({
        conversationId: conv.id,
        title: conv.title,
        createdAt: new Date(conv.create_time * 1000).toISOString(),
        url: `https://chatgpt.com/c/${conv.id}`,
        // ChatGPT exposes no organization/account concept in this flow
        // (unlike Claude, which can span multiple orgs) — both fields are
        // set explicitly to null rather than omitted, so a future reader
        // doesn't mistake the absence for an oversight.
        accountId: null,
        accountName: null,
      }));
  }

  async fetchConversation(entry: ArchiveEntry): Promise<ArchivedConversation> {
    const token = await this.getAccessToken();
    const detail = await fetchJson<ChatGptConversationDetail>(conversationDetailUrl(entry.conversationId), token);

    const nodes = new Map(Object.entries(detail.mapping));
    const chain = walkFromLeaf(nodes, detail.current_node, (n) => n.parent);
    const messages: ArchivedMessage[] = chain.flatMap((node): ArchivedMessage[] => {
      const message = node.message;
      if (!message) {
        // The tree root carries no message.
        return [];
      }
      const role = message.author.role === 'user' ? 'user' : message.author.role === 'assistant' ? 'assistant' : null;
      if (!role) {
        return [];
      }
      const markdown = message.content.parts
        .filter((part): part is string => typeof part === 'string')
        .join('\n\n');
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
