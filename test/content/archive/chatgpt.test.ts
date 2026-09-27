import { describe, it, expect, vi } from 'vitest';
import { ChatGptArchiveAdapter } from '../../../src/content/archive/chatgpt';
import { stubFetch, fetchCallsMatching } from './helpers';

// `stubFetch` matches the FIRST route key that is a substring of the
// requested URL. Detail routes here always carry the conversation id
// (`/backend-api/conversation/c1`) so they can never accidentally swallow
// the plural listing route (`/backend-api/conversations`) or vice versa —
// listed in whichever order, since neither is a substring of the other.

/**
 * Simulates a real paginated `/backend-api/conversations` endpoint: each
 * call returns exactly `limit` items (or fewer once exhausted) regardless
 * of the offset/limit the caller actually requested, so the test controls
 * how many pages are needed independent of the adapter's own page size
 * choice.
 */
function stubPagedFetch({ total, limit }: { total: number; limit: number }) {
  const allItems = Array.from({ length: total }, (_, i) => ({
    id: `c${i}`,
    title: `Conv ${i}`,
    create_time: 1700000000 + i,
  }));
  let cursor = 0;
  const mock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/auth/session')) {
      return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) };
    }
    if (u.includes('/backend-api/conversations')) {
      const items = allItems.slice(cursor, cursor + limit);
      const offset = cursor;
      cursor += items.length;
      return { ok: true, status: 200, json: async () => ({ items, total, limit, offset }) };
    }
    throw new Error(`Unstubbed fetch: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('ChatGptArchiveAdapter', () => {
  it('pages the listing until total is reached', async () => {
    const mock = stubPagedFetch({ total: 3, limit: 2 });
    const entries = await new ChatGptArchiveAdapter().listConversations();
    expect(entries).toHaveLength(3);
    expect(fetchCallsMatching(mock, '/backend-api/conversations')).toHaveLength(2);
  });

  it('throws rather than silently returning fewer conversations than total reports', async () => {
    // The server reports total=5 but the second page comes back empty —
    // a stalled/broken listing must fail loudly, not report 2 as success.
    const mock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/session')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) };
      }
      if (u.includes('/backend-api/conversations')) {
        const offset = new URL(u, 'https://chatgpt.com').searchParams.get('offset');
        if (offset === '0' || offset === null) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ id: 'c0', title: 'A', create_time: 1 }, { id: 'c1', title: 'B', create_time: 2 }],
              total: 5,
              limit: 2,
              offset: 0,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ items: [], total: 5, limit: 2, offset: 2 }) };
      }
      throw new Error(`Unstubbed fetch: ${url}`);
    });
    vi.stubGlobal('fetch', mock);
    await expect(new ChatGptArchiveAdapter().listConversations()).rejects.toThrow(/incomplete|total/i);
  });

  it('sends the bearer token from /api/auth/session and credentials: include on API calls', async () => {
    const mock = stubFetch({
      '/api/auth/session': { accessToken: 'tok-123' },
      '/backend-api/conversations': { items: [], total: 0, limit: 20, offset: 0 },
    });
    await new ChatGptArchiveAdapter().listConversations();
    const call = mock.mock.calls.find(([url]) => String(url).includes('/backend-api/conversations'));
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      credentials: 'include',
      headers: { Authorization: 'Bearer tok-123' },
    });
  });

  it('excludes temporary chats from the listing', async () => {
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversations': {
        items: [
          { id: 'c1', title: 'Keep', create_time: 1 },
          { id: 'c2', title: 'Temp', create_time: 2, is_temporary_chat: true },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      },
    });
    const entries = await new ChatGptArchiveAdapter().listConversations();
    expect(entries.map((e) => e.conversationId)).toEqual(['c1']);
  });

  it('sets accountId and accountName to null: ChatGPT exposes no organization in this flow', async () => {
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversations': {
        items: [{ id: 'c1', title: 'Keep', create_time: 1 }],
        total: 1,
        limit: 20,
        offset: 0,
      },
    });
    const entries = await new ChatGptArchiveAdapter().listConversations();
    expect(entries[0].accountId).toBeNull();
    expect(entries[0].accountName).toBeNull();
  });

  it('walks mapping from current_node and skips the null-message root', async () => {
    const conv = {
      title: 'T',
      create_time: 1700000000,
      current_node: 'n2',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['n1'] },
        n1: {
          id: 'n1',
          parent: 'root',
          children: ['n2'],
          message: { id: 'n1', author: { role: 'user' }, content: { content_type: 'text', parts: ['q'] } },
        },
        n2: {
          id: 'n2',
          parent: 'n1',
          children: [],
          message: {
            id: 'n2',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['a1', 'a2'] },
          },
        },
      },
    };
    stubFetch({ '/api/auth/session': { accessToken: 'tok' }, '/backend-api/conversation/c1': conv });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c1',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages.map((m) => m.sourceId)).toEqual(['n1', 'n2']);
    expect(r.messages[1].markdown).toBe('a1\n\na2');
    expect(r.accountId).toBeNull();
    expect(r.accountName).toBeNull();
  });

  it('follows the active branch from current_node, not mapping key order, dropping abandoned branches', async () => {
    // Declared deliberately out of tree order, with an abandoned sibling
    // ('bad') that array/object order would otherwise splice in. Only a
    // parent-pointer walk from current_node produces the right sequence.
    const conv = {
      title: 'T',
      create_time: 1,
      current_node: 'n3',
      mapping: {
        n3: {
          id: 'n3',
          parent: 'n2',
          children: [],
          message: { id: 'n3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['final'] } },
        },
        bad: {
          id: 'bad',
          parent: 'n1',
          children: [],
          message: {
            id: 'bad',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['abandoned'] },
          },
        },
        root: { id: 'root', parent: null, children: ['n1'], message: null },
        n2: {
          id: 'n2',
          parent: 'n1',
          children: ['n3'],
          message: { id: 'n2', author: { role: 'user' }, content: { content_type: 'text', parts: ['q2'] } },
        },
        n1: {
          id: 'n1',
          parent: 'root',
          children: ['n2', 'bad'],
          message: { id: 'n1', author: { role: 'user' }, content: { content_type: 'text', parts: ['q1'] } },
        },
      },
    };
    stubFetch({ '/api/auth/session': { accessToken: 'tok' }, '/backend-api/conversation/c-branch': conv });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c-branch',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages.map((m) => m.sourceId)).toEqual(['n1', 'n2', 'n3']);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('drops system and tool messages, keeping only user and assistant', async () => {
    const node = (id: string, parent: string | null, role: string, children: string[] = []) => ({
      id,
      parent,
      children,
      message: { id, author: { role }, content: { content_type: 'text', parts: [role] } },
    });
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversation/c2': {
        title: 'T',
        create_time: 1,
        current_node: 'n4',
        mapping: {
          n1: node('n1', null, 'system', ['n2']),
          n2: node('n2', 'n1', 'user', ['n3']),
          n3: node('n3', 'n2', 'tool', ['n4']),
          n4: node('n4', 'n3', 'assistant'),
        },
      },
    });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c2',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('ignores non-string parts rather than emitting [object Object]', async () => {
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversation/c3': {
        title: 'T',
        create_time: 1,
        current_node: 'n1',
        mapping: {
          n1: {
            id: 'n1',
            parent: null,
            children: [],
            message: {
              id: 'n1',
              author: { role: 'user' },
              content: { content_type: 'multimodal_text', parts: [{ image: 'x' }, 'caption'] },
            },
          },
        },
      },
    });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c3',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages[0].markdown).toBe('caption');
  });
  // Regression: reading `content.parts` unconditionally threw
  // `TypeError: Cannot read properties of undefined (reading 'filter')` on
  // these nodes, aborting the whole import. `author.role` is genuinely
  // 'assistant' for both, so the role filter cannot catch them.
  it('skips a code-interpreter node (content_type: code, no parts) instead of crashing', async () => {
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversation/c-code': {
        title: 'T',
        create_time: 1,
        current_node: 'n3',
        mapping: {
          n1: {
            id: 'n1',
            parent: null,
            children: ['n2'],
            message: { id: 'n1', author: { role: 'user' }, content: { content_type: 'text', parts: ['plot it'] } },
          },
          n2: {
            id: 'n2',
            parent: 'n1',
            children: ['n3'],
            message: {
              id: 'n2',
              author: { role: 'assistant' },
              content: { content_type: 'code', language: 'python', text: 'import numpy as np' },
            },
          },
          n3: {
            id: 'n3',
            parent: 'n2',
            children: [],
            message: { id: 'n3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['here it is'] } },
          },
        },
      },
    });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c-code',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages.map((m) => m.sourceId)).toEqual(['n1', 'n3']);
    expect(r.messages.map((m) => m.markdown)).toEqual(['plot it', 'here it is']);
  });

  it('skips a reasoning node (content_type: thoughts, no parts) instead of crashing', async () => {
    stubFetch({
      '/api/auth/session': { accessToken: 'tok' },
      '/backend-api/conversation/c-think': {
        title: 'T',
        create_time: 1,
        current_node: 'n3',
        mapping: {
          n1: {
            id: 'n1',
            parent: null,
            children: ['n2'],
            message: { id: 'n1', author: { role: 'user' }, content: { content_type: 'text', parts: ['why?'] } },
          },
          n2: {
            id: 'n2',
            parent: 'n1',
            children: ['n3'],
            message: {
              id: 'n2',
              author: { role: 'assistant' },
              content: {
                content_type: 'thoughts',
                thoughts: [{ summary: 'Considering', content: 'internal reasoning' }],
              },
            },
          },
          n3: {
            id: 'n3',
            parent: 'n2',
            children: [],
            message: { id: 'n3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['because'] } },
          },
        },
      },
    });
    const r = await new ChatGptArchiveAdapter().fetchConversation({
      conversationId: 'c-think',
      title: 'T',
      createdAt: '',
      url: '',
      accountId: null,
      accountName: null,
    });
    expect(r.messages.map((m) => m.sourceId)).toEqual(['n1', 'n3']);
    expect(r.messages.map((m) => m.markdown)).toEqual(['why?', 'because']);
  });
});
