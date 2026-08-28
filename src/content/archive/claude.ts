/**
 * Claude backfill adapter.
 *
 * Claude scopes conversations under an organization: `/api/organizations`
 * lists every org the current session belongs to, and conversations only
 * exist per-org under `/api/organizations/{org}/chat_conversations`. A
 * single Claude account can carry more than one organization (and this
 * export flow may run against several separate Claude logins in turn), so
 * listing must enumerate every org rather than assuming `orgs[0]` — reading
 * only the first would silently miss whole organizations while still
 * looking like a successful backfill.
 *
 * Each listed entry is tagged with the org it came from (`accountId` /
 * `accountName`) so `fetchConversation` never has to re-derive it, and so
 * the user can tell conversations from different accounts apart once
 * they're all imported into one vault.
 */

import type { ArchiveAdapter, ArchiveEntry, ArchivedConversation, ArchivedMessage } from './types';
import { walkFromLeaf } from './walk';

/** Page size used when probing whether the listing endpoint honours limit/offset. */
const PAGE_SIZE = 100;

interface ClaudeOrganization {
  uuid: string;
  name?: string;
}

interface ClaudeConversationSummary {
  uuid: string;
  name: string;
  created_at: string;
  is_temporary?: boolean;
}

interface ClaudeMessage {
  uuid: string;
  text: string;
  sender: string;
  parent_message_uuid: string | null;
  truncated?: boolean;
}

interface ClaudeConversationDetail {
  uuid: string;
  name: string;
  created_at: string;
  current_leaf_message_uuid: string;
  chat_messages: ClaudeMessage[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Claude API request failed (${res.status}): ${url}`);
  }
  return res.json() as Promise<T>;
}

function organizationsUrl(): string {
  return 'https://claude.ai/api/organizations';
}

function conversationListUrl(orgId: string, offset: number): string {
  return `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=${PAGE_SIZE}&offset=${offset}`;
}

function conversationDetailUrl(orgId: string, conversationId: string): string {
  return `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=raw`;
}

/** Same listing endpoint with no paging parameters at all. */
function conversationListUrlUnparameterized(orgId: string): string {
  return `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
}

/**
 * Fetch every conversation summary for one org, paging only if the server
 * actually honours `limit`/`offset`. Detected at runtime rather than
 * hardcoded from a one-time observation:
 *  - if the first response already exceeds `PAGE_SIZE`, both params were
 *    ignored and that single response is the complete list;
 *  - otherwise, further pages are requested. A page shorter than
 *    `PAGE_SIZE` means the listing is genuinely exhausted. But a page that
 *    comes back at exactly `PAGE_SIZE` items, all of which we've already
 *    seen, is NOT the same thing — it means `offset` is being ignored while
 *    `limit` is honoured, and stopping there would silently drop every
 *    conversation past the first page. That shape is disambiguated by
 *    retrying once with no paging parameters at all: if that returns more
 *    than `PAGE_SIZE`, it's everything; if it's still capped at `PAGE_SIZE`,
 *    we cannot safely enumerate the rest and must fail loudly rather than
 *    report a truncated backfill as a success.
 */
async function fetchOrgConversationList(orgId: string): Promise<ClaudeConversationSummary[]> {
  const first = await fetchJson<ClaudeConversationSummary[]>(conversationListUrl(orgId, 0));
  if (first.length > PAGE_SIZE) {
    return first;
  }

  const all = [...first];
  const seen = new Set(all.map((c) => c.uuid));
  let page = first;
  let offset = PAGE_SIZE;
  while (page.length === PAGE_SIZE) {
    const next = await fetchJson<ClaudeConversationSummary[]>(conversationListUrl(orgId, offset));
    const newItems = next.filter((c) => !seen.has(c.uuid));

    if (next.length === PAGE_SIZE && newItems.length === 0) {
      const unparameterized = await fetchJson<ClaudeConversationSummary[]>(
        conversationListUrlUnparameterized(orgId)
      );
      if (unparameterized.length > PAGE_SIZE) {
        return unparameterized;
      }
      throw new Error(
        `Claude conversation listing for org ${orgId} is capped at ${PAGE_SIZE} items even without paging ` +
          'parameters (offset appears to be ignored). Refusing to report a partial import as complete.'
      );
    }

    for (const item of newItems) {
      seen.add(item.uuid);
      all.push(item);
    }
    page = next;
    offset += PAGE_SIZE;
  }
  return all;
}

export class ClaudeArchiveAdapter implements ArchiveAdapter {
  readonly platform = 'claude' as const;

  async listConversations(): Promise<ArchiveEntry[]> {
    const orgs = await fetchJson<ClaudeOrganization[]>(organizationsUrl());
    const entries: ArchiveEntry[] = [];
    for (const org of orgs) {
      const conversations = await fetchOrgConversationList(org.uuid);
      for (const conv of conversations) {
        if (conv.is_temporary) {
          continue;
        }
        entries.push({
          conversationId: conv.uuid,
          title: conv.name,
          createdAt: conv.created_at,
          url: `https://claude.ai/chat/${conv.uuid}`,
          accountId: org.uuid,
          accountName: org.name ?? null,
        });
      }
    }
    return entries;
  }

  async fetchConversation(entry: ArchiveEntry): Promise<ArchivedConversation> {
    if (!entry.accountId) {
      // `listConversations()` always tags entries with the org they came
      // from; a missing `accountId` here means a caller skipped listing or
      // lost the field, not an org we can safely guess at. Guessing (e.g.
      // trying every org and swallowing errors) would turn a real outage
      // in one org into a misleading "not found" from a different one.
      throw new Error(
        `Cannot fetch Claude conversation ${entry.conversationId}: missing accountId (expected from listConversations())`
      );
    }
    const orgId = entry.accountId;
    const accountName = entry.accountName ?? null;
    const detail = await fetchJson<ClaudeConversationDetail>(conversationDetailUrl(orgId, entry.conversationId));

    const nodes = new Map(detail.chat_messages.map((m) => [m.uuid, m]));
    const chain = walkFromLeaf(nodes, detail.current_leaf_message_uuid, (m) => m.parent_message_uuid);
    const messages: ArchivedMessage[] = chain.flatMap((m): ArchivedMessage[] => {
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
      if (!role) {
        return [];
      }
      return [{ role, markdown: m.text, sourceId: m.uuid, truncated: m.truncated ?? false }];
    });

    return {
      platform: 'claude',
      conversationId: entry.conversationId,
      title: entry.title,
      url: entry.url,
      createdAt: entry.createdAt,
      messages,
      accountId: orgId,
      accountName,
    };
  }
}
