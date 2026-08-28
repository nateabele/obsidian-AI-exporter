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

/**
 * Fetch every conversation summary for one org, paging only if the server
 * actually honours `limit`/`offset`. Detected at runtime rather than
 * hardcoded from a one-time observation:
 *  - if the first response already exceeds `PAGE_SIZE`, the params were
 *    ignored and that single response is the complete list;
 *  - otherwise, a further page is requested; if it contributes no ids we
 *    haven't already seen, either the endpoint is exhausted or it is
 *    ignoring `offset` and replaying the same page — either way, stop.
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
    if (newItems.length === 0) {
      break;
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
    const { orgId, accountName, detail } = entry.accountId
      ? {
          orgId: entry.accountId,
          accountName: entry.accountName ?? null,
          detail: await fetchJson<ClaudeConversationDetail>(
            conversationDetailUrl(entry.accountId, entry.conversationId)
          ),
        }
      : await this.discoverConversation(entry.conversationId);

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

  /**
   * Fallback for a fetch that isn't carrying `accountId` (e.g. a
   * conversation reference persisted before this field existed): rediscover
   * which org owns it by trying each org in turn. Normal callers always
   * supply `accountId` from `listConversations()`, so this path is not on
   * the hot path.
   */
  private async discoverConversation(
    conversationId: string
  ): Promise<{ orgId: string; accountName: string | null; detail: ClaudeConversationDetail }> {
    const orgs = await fetchJson<ClaudeOrganization[]>(organizationsUrl());
    for (const org of orgs) {
      try {
        const detail = await fetchJson<ClaudeConversationDetail>(
          conversationDetailUrl(org.uuid, conversationId)
        );
        return { orgId: org.uuid, accountName: org.name ?? null, detail };
      } catch {
        continue;
      }
    }
    throw new Error(`Could not find Claude conversation ${conversationId} in any organization`);
  }
}
