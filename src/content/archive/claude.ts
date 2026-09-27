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
 * Each listed entry is tagged with the org it came from (`accountId`) so
 * `fetchConversation` never has to re-derive it. `accountName` instead
 * identifies the signed-in *login* — read once per run from the page's own
 * user menu (`account-identity.ts`), since the org's own name only tells
 * orgs apart, not logins, and two orgs under the same login would
 * otherwise look like different accounts in the vault. Together they let
 * the user tell conversations from different accounts apart once they're
 * all imported into one vault: two orgs under one login share an
 * `accountName` but differ by `accountId`; three separate logins give
 * three different `accountName`s.
 */

import type { ArchiveAdapter, ArchiveEntry, ArchivedConversation, ArchivedMessage } from './types';
import { walkFromLeaf } from './walk';
import { readSignedInAccountName } from './account-identity';
import type { ArchiveDiscoverFailure } from '../../lib/types';
import { extractErrorMessage } from '../../lib/error-utils';

/** Page size used when probing whether the listing endpoint honours limit/offset. */
const PAGE_SIZE = 100;

interface ClaudeOrganization {
  uuid: string;
  /**
   * Values like `chat`, `api`, `claude_pro` — an org without `chat` is a
   * Console/API-only org (or a pending membership) that will 403 on the
   * conversation-listing endpoint every time. `unknown` on purpose: this is
   * read defensively (see `orgMayHaveChat`) rather than trusted, since a
   * missing whole organization's conversations while still reporting
   * success is worse than one avoidable 403.
   */
  capabilities?: unknown;
}

/**
 * Whether an org's conversation-listing endpoint is even worth calling.
 * Only skips when `capabilities` is a genuine, non-empty array that omits
 * `chat` — any other shape (missing, not an array, empty) is treated as
 * "unknown" and the org is still attempted, per the fail-open posture
 * described on `ClaudeOrganization.capabilities`.
 */
function orgMayHaveChat(org: ClaudeOrganization): boolean {
  const caps = org.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) {
    return true;
  }
  return caps.includes('chat');
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
  const seen = new Set(all.map(c => c.uuid));
  let page = first;
  let offset = PAGE_SIZE;
  while (page.length === PAGE_SIZE) {
    const next = await fetchJson<ClaudeConversationSummary[]>(conversationListUrl(orgId, offset));
    const newItems = next.filter(c => !seen.has(c.uuid));

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

  /**
   * Orgs skipped by `listConversations()` because they failed anyway (403,
   * network error, unexpected response shape) after being deemed worth
   * attempting. Reset at the start of every `listConversations()` call, not
   * accumulated across calls — `discoverConversations()` reads this right
   * after awaiting `listConversations()`.
   */
  listFailures: ArchiveDiscoverFailure[] = [];

  async listConversations(): Promise<ArchiveEntry[]> {
    // Read once for the whole run: the signed-in login doesn't change
    // mid-listing, and opening/closing the user menu per org (or per
    // conversation) would flicker the page across what can be dozens of
    // entries.
    const accountName = await readSignedInAccountName();
    const orgs = await fetchJson<ClaudeOrganization[]>(organizationsUrl());
    const entries: ArchiveEntry[] = [];
    const failures: ArchiveDiscoverFailure[] = [];
    let attempted = 0;
    for (const org of orgs) {
      if (!orgMayHaveChat(org)) {
        continue;
      }
      attempted += 1;
      try {
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
            accountName,
          });
        }
      } catch (error) {
        // One org that can't be listed (a Console/API-only org the
        // `capabilities` check didn't catch, a transient 403, a network
        // blip) must not cost the user every other org's conversations —
        // record it and keep going.
        failures.push({
          conversationId: org.uuid,
          title: `Claude organization ${org.uuid}`,
          error: extractErrorMessage(error),
        });
      }
    }
    this.listFailures = failures;

    // A skipped org is survivable; every attempted org failing is not — an
    // empty array here is indistinguishable from "you have no
    // conversations", which would report a total failure as a successful
    // import of nothing.
    if (attempted > 0 && failures.length === attempted) {
      throw new Error(
        `Claude conversation listing failed for every accessible organization (${failures.length}/${orgs.length}): ` +
          failures.map(f => f.error).join('; ')
      );
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
    const detail = await fetchJson<ClaudeConversationDetail>(
      conversationDetailUrl(orgId, entry.conversationId)
    );

    const nodes = new Map(detail.chat_messages.map(m => [m.uuid, m]));
    const chain = walkFromLeaf(nodes, detail.current_leaf_message_uuid, m => m.parent_message_uuid);
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
