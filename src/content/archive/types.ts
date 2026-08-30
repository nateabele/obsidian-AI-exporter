import type { AIPlatform, ArchiveDiscoverFailure } from '../../lib/types';

/**
 * A conversation summary from a platform's list/history endpoint, as
 * discovered during backfill listing. `accountId`/`accountName` record
 * provenance for platforms (Claude) with multiple accounts/organizations;
 * they are learned once at listing time and carried through to
 * `fetchConversation` so the adapter never has to re-derive them per fetch.
 * `null` for platforms (ChatGPT) that expose no organization in this flow.
 */
export interface ArchiveEntry {
  conversationId: string;
  title: string;
  createdAt: string;
  url: string;
  accountId: string | null;
  accountName: string | null;
}

export interface ArchivedMessage {
  role: 'user' | 'assistant';
  markdown: string;
  sourceId: string;
  truncated?: boolean;
}

export interface ArchivedConversation {
  platform: AIPlatform;
  conversationId: string;
  title: string;
  url: string;
  createdAt: string;
  messages: ArchivedMessage[];
  accountId: string | null;
  accountName: string | null;
}

export interface ArchiveAdapter {
  platform: AIPlatform;
  listConversations(): Promise<ArchiveEntry[]>;
  fetchConversation(entry: ArchiveEntry): Promise<ArchivedConversation>;
  /**
   * Survivable failures from the most recent `listConversations()` call —
   * e.g. one organization out of several that 403'd (Claude). Optional and
   * left `undefined` by adapters (ChatGPT) that have nothing analogous to
   * report; `discoverConversations()` folds it into the same `failures`
   * list it already builds per-conversation, so a skipped org surfaces the
   * same way a skipped conversation does rather than through a parallel
   * channel.
   */
  listFailures?: ArchiveDiscoverFailure[];
}
