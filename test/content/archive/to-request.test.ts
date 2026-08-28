import { describe, it, expect } from 'vitest';
import { toBackfillRequest } from '../../../src/content/archive/to-request';
import { generateHash } from '../../../src/lib/hash';
import type { ArchivedConversation } from '../../../src/content/archive/types';

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

  it('hashes with the same formula buildManifest() uses (`${role} ${markdown}`)', () => {
    const request = toBackfillRequest(CONVERSATION);

    expect(request.messages[0].hash).toBe(generateHash('user hello'));
    expect(request.messages[1].hash).toBe(generateHash('assistant hi there'));
  });
});
