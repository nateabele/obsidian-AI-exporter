/**
 * Manifest building for continuous transcript sync.
 *
 * A manifest is the ordered list of per-message hashes for the whole visible
 * conversation. The server diffs it against what it has stored, which is what
 * makes re-sending an increment free and makes divergence (an edited or
 * regenerated message) detectable rather than silently corrupting the tail.
 *
 * Lives in `src/content/`, not `src/lib/`, because building a block requires
 * the same HTML->Markdown conversion the manual export path uses
 * (`htmlToMarkdown` / `escapeUserText`, both in `./markdown-rules`) and
 * `lib/` must not import from `content/` (ADR-012, test/arch/layering.test.ts).
 */

import { generateHash } from '../lib/hash';
import type { ChatSyncBlock, ConversationMessage } from '../lib/types';
import { htmlToMarkdown, escapeUserText } from './markdown-rules';

export function buildManifest(messages: ConversationMessage[]): {
  manifest: string[];
  blocks: ChatSyncBlock[];
} {
  const blocks: ChatSyncBlock[] = messages.map(message => {
    // Assistant `content` is sanitized innerHTML; user `content` is plain
    // pasted text. Convert/escape the same way the manual export path does
    // (markdown-formatting.ts) so a synced note never carries raw HTML tags
    // — and hash the CONVERTED text, not the raw content, so the hash
    // actually matches what gets stored and doesn't churn the moment the
    // conversion logic changes.
    const markdown =
      message.role === 'assistant'
        ? htmlToMarkdown(message.content)
        : escapeUserText(message.content);
    return {
      role: message.role,
      markdown,
      hash: generateHash(`${message.role} ${markdown}`),
    };
  });
  return { manifest: blocks.map(b => b.hash), blocks };
}

export function diffBlocks(
  previousManifest: string[],
  manifest: string[],
  blocks: ChatSyncBlock[]
): ChatSyncBlock[] {
  const shared = Math.min(previousManifest.length, manifest.length);
  let divergeAt = shared;
  for (let i = 0; i < shared; i += 1) {
    if (previousManifest[i] !== manifest[i]) {
      divergeAt = i;
      break;
    }
  }
  return blocks.slice(divergeAt);
}
