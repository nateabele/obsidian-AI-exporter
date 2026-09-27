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
import { escapeAngleBrackets, escapeUserText } from '../markdown-rules';
import type { ArchivedConversation, ArchivedMessage } from './types';

/**
 * Applies the SAME vault-safety escaping `buildManifest()` applies on the
 * live path (`src/content/manifest.ts`): `<`/`>` for every role, plus `$`
 * for user text, so pasted shell/YAML (`$VAR`, `$$TMP`) is not parsed by
 * Obsidian as math — dozens of stray `$` otherwise create giant "math"
 * spans that blank the note and hang the KaTeX/MathJax renderer
 * (`markdown-rules.ts`). Backfill markdown comes straight from a platform
 * JSON API and used to reach the vault raw, so an imported conversation
 * containing `$VAR` or `<div>` could blank the note that live sync would
 * have written safely.
 *
 * Applied exactly once, here, rather than in each adapter: this is the one
 * point every backfill payload passes through, so there is no path on
 * which it can run twice and double-escape.
 *
 * The live path additionally carries Turndown's own backslash escapes
 * (`\_`, `\*`, …), which are an artifact of the HTML→Markdown conversion
 * and are deliberately NOT reproduced here — reproducing them would mangle
 * markdown the platform already authored. The server bridges the residual
 * difference for identity only, by stripping backslash escapes in
 * `normalizeForIdentity` (mail-api `server/services/chat/blockAlignment.js`),
 * which is why cross-producer alignment still matches after this change.
 */
function escapeForVault(message: ArchivedMessage): string {
  return message.role === 'user'
    ? escapeUserText(message.markdown)
    : escapeAngleBrackets(message.markdown);
}

/**
 * Uses the SAME formula as `buildManifest()` in `src/content/manifest.ts`
 * (`${role} ${markdown}`), over the SAME escaped markdown. If these two
 * drift, a backfilled conversation and its later live syncs disagree about
 * every message and the note forks.
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
    messages: conv.messages.map(m => {
      const markdown = escapeForVault(m);
      return {
        role: m.role,
        markdown,
        sourceId: m.sourceId,
        truncated: m.truncated,
        hash: generateHash(`${m.role} ${markdown}`),
      };
    }),
  };
}
