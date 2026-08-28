import { describe, it, expect } from 'vitest';
import { ClaudeArchiveAdapter } from '../../../src/content/archive/claude';
import { stubFetch, fetchCallsMatching } from './helpers';

// `stubFetch` matches the FIRST route key that is a substring of the
// requested URL, and every Claude endpoint is nested under
// `/api/organizations`. Routes here are listed most-specific-first so the
// bare `/api/organizations` key (which matches everything) is only reached
// once nothing more specific applies.
const ORGS = [{ uuid: 'org-1' }, { uuid: 'org-2' }];
const LIST_1 = [{ uuid: 'c1', name: 'First', created_at: '2024-06-20T20:54:54Z', is_temporary: false }];
const LIST_2 = [
  { uuid: 'c2', name: 'Second', created_at: '2025-01-02T00:00:00Z', is_temporary: false },
  { uuid: 'tmp', name: 'Temp', created_at: '2025-01-03T00:00:00Z', is_temporary: true },
];

function mkConv(i: number) {
  return {
    uuid: `id-${i}`,
    name: `Conv ${i}`,
    created_at: '2025-01-01T00:00:00Z',
    is_temporary: false,
  };
}

describe('ClaudeArchiveAdapter', () => {
  it('enumerates conversations across ALL organizations and drops temporary chats', async () => {
    stubFetch({
      '/api/organizations/org-1/chat_conversations': LIST_1,
      '/api/organizations/org-2/chat_conversations': LIST_2,
      '/api/organizations': ORGS,
    });
    const entries = await new ClaudeArchiveAdapter().listConversations();
    expect(entries.map((e) => e.conversationId)).toEqual(['c1', 'c2']);
  });

  it('tags each entry with the organization it came from', async () => {
    const orgs = [
      { uuid: 'org-1', name: 'Personal' },
      { uuid: 'org-2', name: 'Work' },
    ];
    stubFetch({
      '/api/organizations/org-1/chat_conversations': LIST_1,
      '/api/organizations/org-2/chat_conversations': LIST_2,
      '/api/organizations': orgs,
    });
    const entries = await new ClaudeArchiveAdapter().listConversations();
    const fromOrg1 = entries.find((e) => e.conversationId === 'c1');
    const fromOrg2 = entries.find((e) => e.conversationId === 'c2');
    expect(fromOrg1?.accountId).toBe('org-1');
    expect(fromOrg1?.accountName).toBe('Personal');
    expect(fromOrg2?.accountId).toBe('org-2');
    expect(fromOrg2?.accountName).toBe('Work');
  });

  it('follows the active leaf, dropping abandoned branches, and maps human to user', async () => {
    const conv = {
      uuid: 'c1',
      name: 'First',
      created_at: '2024-06-20T20:54:54Z',
      current_leaf_message_uuid: 'm3',
      chat_messages: [
        { uuid: 'm1', text: 'q', sender: 'human', index: 0, parent_message_uuid: null, truncated: false },
        { uuid: 'm2', text: 'a', sender: 'assistant', index: 1, parent_message_uuid: 'm1', truncated: false },
        {
          uuid: 'bad',
          text: 'abandoned',
          sender: 'assistant',
          index: 1,
          parent_message_uuid: 'm1',
          truncated: false,
        },
        { uuid: 'm3', text: 'q2', sender: 'human', index: 2, parent_message_uuid: 'm2', truncated: false },
      ],
    };
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': conv,
      '/api/organizations': ORGS,
    });
    const result = await new ClaudeArchiveAdapter().fetchConversation({
      accountId: 'org-1',
      accountName: null,
      conversationId: 'c1',
      title: 'First',
      createdAt: '2024-06-20T20:54:54Z',
      url: '',
    });
    expect(result.messages.map((m) => m.sourceId)).toEqual(['m1', 'm2', 'm3']);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('drops messages from senders other than human/assistant', async () => {
    const conv = {
      uuid: 'c1',
      name: 'First',
      created_at: '2024-06-20T20:54:54Z',
      current_leaf_message_uuid: 'm2',
      chat_messages: [
        { uuid: 'm1', text: 'sys', sender: 'system', index: 0, parent_message_uuid: null, truncated: false },
        { uuid: 'm2', text: 'a', sender: 'assistant', index: 1, parent_message_uuid: 'm1', truncated: false },
      ],
    };
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': conv,
      '/api/organizations': ORGS,
    });
    const result = await new ClaudeArchiveAdapter().fetchConversation({
      accountId: 'org-1',
      accountName: null,
      conversationId: 'c1',
      title: 'First',
      createdAt: '2024-06-20T20:54:54Z',
      url: '',
    });
    expect(result.messages.map((m) => m.sourceId)).toEqual(['m2']);
  });

  it('propagates the truncated flag so the server can refuse the conversation', async () => {
    const conv = {
      uuid: 'c9',
      name: 'T',
      created_at: '2024-01-01T00:00:00Z',
      current_leaf_message_uuid: 'm1',
      chat_messages: [
        { uuid: 'm1', text: 'partial', sender: 'human', index: 0, parent_message_uuid: null, truncated: true },
      ],
    };
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c9': conv,
      '/api/organizations': ORGS,
    });
    const r = await new ClaudeArchiveAdapter().fetchConversation({
      accountId: 'org-1',
      accountName: null,
      conversationId: 'c9',
      title: 'T',
      createdAt: '2024-01-01T00:00:00Z',
      url: '',
    });
    expect(r.messages[0].truncated).toBe(true);
  });

  it('throws rather than guessing the organization when accountId is missing', async () => {
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': { uuid: 'c1' },
      '/api/organizations': ORGS,
    });
    await expect(
      new ClaudeArchiveAdapter().fetchConversation({
        accountId: null,
        accountName: null,
        conversationId: 'c1',
        title: 'First',
        createdAt: '2024-06-20T20:54:54Z',
        url: '',
      })
    ).rejects.toThrow(/accountId/i);
  });

  it('makes a single request when the listing endpoint ignores limit/offset', async () => {
    const bigList = Array.from({ length: 150 }, (_, i) => mkConv(i));
    const mock = stubFetch({
      '/api/organizations/org-1/chat_conversations': bigList,
      '/api/organizations': [{ uuid: 'org-1' }],
    });
    const entries = await new ClaudeArchiveAdapter().listConversations();
    expect(entries).toHaveLength(150);
    expect(fetchCallsMatching(mock, 'chat_conversations')).toHaveLength(1);
  });

  it('pages when the listing endpoint honours limit/offset', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => mkConv(i));
    const page1 = Array.from({ length: 20 }, (_, i) => mkConv(100 + i));
    const mock = stubFetch({
      '/api/organizations/org-1/chat_conversations?limit=100&offset=0': page0,
      '/api/organizations/org-1/chat_conversations?limit=100&offset=100': page1,
      '/api/organizations': [{ uuid: 'org-1' }],
    });
    const entries = await new ClaudeArchiveAdapter().listConversations();
    expect(entries).toHaveLength(120);
    expect(fetchCallsMatching(mock, 'chat_conversations')).toHaveLength(2);
  });

  it('retries unparameterized and succeeds when the endpoint honours limit but ignores offset', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => mkConv(i));
    // offset=100 is ignored: the server replays page 0 verbatim.
    const everything = Array.from({ length: 105 }, (_, i) => mkConv(i));
    stubFetch({
      '/api/organizations/org-1/chat_conversations?limit=100&offset=0': page0,
      '/api/organizations/org-1/chat_conversations?limit=100&offset=100': page0,
      '/api/organizations/org-1/chat_conversations': everything,
      '/api/organizations': [{ uuid: 'org-1' }],
    });
    const entries = await new ClaudeArchiveAdapter().listConversations();
    expect(entries).toHaveLength(105);
  });

  it('throws rather than silently truncating when the endpoint caps the list regardless of parameters', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => mkConv(i));
    // Even the unparameterized request comes back capped at 100 — a real
    // 105-conversation account would otherwise silently lose 5 entries.
    const stillCapped = Array.from({ length: 100 }, (_, i) => mkConv(i));
    stubFetch({
      '/api/organizations/org-1/chat_conversations?limit=100&offset=0': page0,
      '/api/organizations/org-1/chat_conversations?limit=100&offset=100': page0,
      '/api/organizations/org-1/chat_conversations': stillCapped,
      '/api/organizations': [{ uuid: 'org-1' }],
    });
    await expect(new ClaudeArchiveAdapter().listConversations()).rejects.toThrow(/cap|limit/i);
  });

  it('always fetches with credentials: include', async () => {
    const mock = stubFetch({
      '/api/organizations/org-1/chat_conversations': LIST_1,
      '/api/organizations': [{ uuid: 'org-1' }],
    });
    await new ClaudeArchiveAdapter().listConversations();
    expect(mock.mock.calls.length).toBeGreaterThan(0);
    for (const call of mock.mock.calls) {
      expect(call[1]).toEqual({ credentials: 'include' });
    }
  });
});
