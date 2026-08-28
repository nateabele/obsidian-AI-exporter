/**
 * Converts an `ArchivedConversation` (an adapter's whole-conversation
 * fetch — see `ClaudeArchiveAdapter`/`ChatGptArchiveAdapter`) into the
 * payload `POST /api/chat/backfill` expects.
 *
 * Hashes are computed here, not by the adapters: `ArchivedMessage` has no
 * `hash` field, and `ChatBackfillRequest.messages` requires one.
 */
import { generateHash } from '../../lib/hash';
import type { ChatBackfillRequest } from '../../lib/types';
import type { ArchivedConversation } from './types';

/**
 * Uses the SAME formula as `buildManifest()` in `src/content/manifest.ts`
 * (`${role} ${markdown}`). If these two drift, a backfilled conversation
 * and its later live syncs disagree about every message and the note
 * forks.
 */
export function toBackfillRequest(conv: ArchivedConversation): ChatBackfillRequest {
  return {
    conversationId: conv.conversationId,
    platform: conv.platform,
    title: conv.title,
    url: conv.url,
    createdAt: conv.createdAt,
    accountId: conv.accountId,
    accountName: conv.accountName,
    messages: conv.messages.map(m => ({
      role: m.role,
      markdown: m.markdown,
      sourceId: m.sourceId,
      truncated: m.truncated,
      hash: generateHash(`${m.role} ${m.markdown}`),
    })),
  };
}
