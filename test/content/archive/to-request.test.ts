import { describe, it, expect } from 'vitest';
import { toBackfillRequest } from '../../../src/content/archive/to-request';
import { buildManifest } from '../../../src/content/manifest';
import type { ArchivedConversation } from '../../../src/content/archive/types';
import type { ConversationMessage } from '../../../src/lib/types';

const CONVERSATION: ArchivedConversation = {
  platform: 'claude',
  conversationId: 'c1',
  title: 'Backfilled chat',
  url: 'https://claude.ai/chat/c1',
  createdAt: '2025-01-01T00:00:00Z',
  accountId: 'org-1',
  accountName: 'Personal',
  messages: [
    { role: 'user', markdown: 'hello', sourceId: 'm1' },
    { role: 'assistant', markdown: 'hi there', sourceId: 'm2', truncated: true },
  ],
};

describe('toBackfillRequest', () => {
  it('carries conversation-level fields through unchanged', () => {
    const request = toBackfillRequest(CONVERSATION);

    expect(request.conversationId).toBe('c1');
    expect(request.platform).toBe('claude');
    expect(request.title).toBe('Backfilled chat');
    expect(request.url).toBe('https://claude.ai/chat/c1');
    expect(request.createdAt).toBe('2025-01-01T00:00:00Z');
    expect(request.accountId).toBe('org-1');
    expect(request.accountName).toBe('Personal');
  });

  it('preserves accountId/accountName as null for platforms without an organization', () => {
    const request = toBackfillRequest({ ...CONVERSATION, accountId: null, accountName: null });

    expect(request.accountId).toBeNull();
    expect(request.accountName).toBeNull();
  });

  it('maps each message and preserves sourceId/truncated', () => {
    const request = toBackfillRequest(CONVERSATION);

    expect(request.messages).toEqual([
      expect.objectContaining({ role: 'user', markdown: 'hello', sourceId: 'm1' }),
      expect.objectContaining({
        role: 'assistant',
        markdown: 'hi there',
        sourceId: 'm2',
        truncated: true,
      }),
    ]);
  });

  // Pinned against buildManifest() itself, not against a restatement of its
  // formula: restating `generateHash(`${role} ${markdown}`)` here passed
  // whether or not the two producers still agreed, which is the one
  // invariant this module's doc comment says must never drift.
  it('produces exactly the hashes buildManifest() produces for the same messages', () => {
    const live: ConversationMessage[] = [
      // The live path's user `content` is plain text and its assistant
      // `content` is sanitized innerHTML — the same two messages the
      // backfill fixture above carries as markdown.
      { id: 'm1', role: 'user', content: 'hello', index: 0 },
      { id: 'm2', role: 'assistant', content: '<p>hi there</p>', index: 1 },
    ];

    expect(toBackfillRequest(CONVERSATION).messages.map(m => m.hash)).toEqual(
      buildManifest(live).manifest
    );
  });

  // The live path escapes `<`/`>` (and `$` for user text) before anything
  // reaches the vault: dozens of stray `$` otherwise create giant "math"
  // spans that blank the note and hang the KaTeX/MathJax renderer
  // (markdown-rules.ts). Backfill used to write raw platform markdown
  // straight through, so an imported conversation could blank a note that
  // live sync would have written safely.
  it('escapes angle brackets, and `$` in user text, exactly as the live path does', () => {
    const risky: ArchivedConversation = {
      ...CONVERSATION,
      messages: [
        { role: 'user', markdown: 'run echo $PATH and compare a < b', sourceId: 'm1' },
        { role: 'assistant', markdown: 'wrap it in a <div> when x > y', sourceId: 'm2' },
      ],
    };

    const request = toBackfillRequest(risky);

    // Escaped once, not twice — `\\$` not `\\\\\\$`.
    expect(request.messages[0].markdown).toBe('run echo \\$PATH and compare a \\< b');
    expect(request.messages[1].markdown).toBe('wrap it in a \\<div\\> when x \\> y');
  });

  it('leaves `$` alone in assistant text so KaTeX math survives, matching escapeAngleBrackets', () => {
    const request = toBackfillRequest({
      ...CONVERSATION,
      messages: [{ role: 'assistant', markdown: 'the cost is $O(n)$ overall', sourceId: 'm1' }],
    });

    expect(request.messages[0].markdown).toBe('the cost is $O(n)$ overall');
  });

  // The cross-producer seam that Turndown's escapes cannot bridge: a user
  // message is plain text on BOTH paths, so once backfill applies the same
  // escaping, the two producers agree byte-for-byte and hash-for-hash.
  it('agrees with buildManifest() byte-for-byte on user text needing escaping', () => {
    const raw = 'run echo $PATH and compare a < b';
    const request = toBackfillRequest({
      ...CONVERSATION,
      messages: [{ role: 'user', markdown: raw, sourceId: 'm1' }],
    });
    const { manifest, blocks } = buildManifest([
      { id: 'm1', role: 'user', content: raw, index: 0 },
    ]);

    expect(request.messages[0].markdown).toBe(blocks[0].markdown);
    expect(request.messages[0].hash).toBe(manifest[0]);
  });
});
