/**
 * Manifest building for continuous transcript sync.
 *
 * A manifest is the ordered list of per-message hashes for the whole visible
 * conversation. The server diffs it against what it has stored, which is what
 * makes re-sending an increment free and makes divergence (an edited or
 * regenerated message) detectable rather than silently corrupting the tail.
 */

import { generateHash } from './hash';
import type { ChatSyncBlock, ConversationMessage } from './types';

export function buildManifest(messages: ConversationMessage[]): {
  manifest: string[];
  blocks: ChatSyncBlock[];
} {
  const blocks: ChatSyncBlock[] = messages.map(message => ({
    role: message.role,
    markdown: message.content,
    hash: generateHash(`${message.role} ${message.content}`),
  }));
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
