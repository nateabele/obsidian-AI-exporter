import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  discoverConversations,
  fetchConversationForRepair,
  registerArchiveDiscoveryListener,
} from '../../../src/content/archive/discover';
import { setClaudeLocation, setNonClaudeLocation, resetLocation } from '../../fixtures/dom-helpers';
import { stubFetch } from './helpers';
import type { ArchiveDiscoverResponse } from '../../../src/lib/types';

const ORGS = [{ uuid: 'org-1', name: 'Personal' }];
const CONVERSATIONS = [
  { uuid: 'c1', name: 'Conv 1', created_at: '2025-01-01T00:00:00Z', is_temporary: false },
];
const DETAIL = {
  uuid: 'c1',
  name: 'Conv 1',
  created_at: '2025-01-01T00:00:00Z',
  current_leaf_message_uuid: 'm2',
  chat_messages: [
    { uuid: 'm1', text: 'hello', sender: 'human', parent_message_uuid: null },
    { uuid: 'm2', text: 'hi there', sender: 'assistant', parent_message_uuid: 'm1' },
  ],
};

describe('discoverConversations', () => {
  beforeEach(() => {
    resetLocation();
  });

  it('rejects platforms without an ArchiveAdapter', async () => {
    setNonClaudeLocation('gemini.google.com');

    await expect(discoverConversations()).rejects.toThrow(/not supported/);
  });

  it('returns backfill-ready payloads for a supported platform', async () => {
    setClaudeLocation('c1');
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': DETAIL,
      '/api/organizations/org-1/chat_conversations': CONVERSATIONS,
      '/api/organizations': ORGS,
    });

    const { conversations, failures } = await discoverConversations();

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: 'c1',
      platform: 'claude',
      accountId: 'org-1',
      accountName: 'Personal',
    });
    expect(conversations[0].messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(conversations[0].messages[0].hash).toBeTruthy();
    expect(failures).toEqual([]);
  });

  // Regression: with no per-entry guard, one unreadable conversation threw
  // out of the loop and the discovery listener turned it into
  // `{success: false}` — so a sweep over 40 conversations that hit a single
  // bad one imported nothing at all.
  it('skips and reports a conversation that cannot be fetched, still importing the rest', async () => {
    setClaudeLocation('c1');
    const mock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/chat_conversations/bad')) {
        // e.g. a conversation the detail endpoint 500s on
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (u.includes('/chat_conversations/c1')) {
        return { ok: true, status: 200, json: async () => DETAIL };
      }
      if (u.includes('/chat_conversations/c2')) {
        return { ok: true, status: 200, json: async () => ({ ...DETAIL, uuid: 'c2', name: 'Conv 2' }) };
      }
      if (u.includes('/chat_conversations')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            CONVERSATIONS[0],
            { uuid: 'bad', name: 'Broken conv', created_at: '2025-01-02T00:00:00Z', is_temporary: false },
            { uuid: 'c2', name: 'Conv 2', created_at: '2025-01-03T00:00:00Z', is_temporary: false },
          ],
        };
      }
      if (u.includes('/api/organizations')) {
        return { ok: true, status: 200, json: async () => ORGS };
      }
      throw new Error(`Unstubbed fetch: ${url}`);
    });
    vi.stubGlobal('fetch', mock);

    const { conversations, failures } = await discoverConversations();

    expect(conversations.map(c => c.conversationId)).toEqual(['c1', 'c2']);
    expect(failures).toEqual([
      { conversationId: 'bad', title: 'Broken conv', error: expect.stringContaining('500') },
    ]);
  });
});

describe('fetchConversationForRepair', () => {
  beforeEach(() => {
    resetLocation();
  });

  it('rejects platforms without an ArchiveAdapter', async () => {
    setNonClaudeLocation('gemini.google.com');

    await expect(fetchConversationForRepair('c1')).rejects.toThrow(/not supported/);
  });

  it('fetches and converts the one matching conversation, tagged with its listing accountId', async () => {
    setClaudeLocation('c1');
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': DETAIL,
      '/api/organizations/org-1/chat_conversations': CONVERSATIONS,
      '/api/organizations': ORGS,
    });

    const conversation = await fetchConversationForRepair('c1');

    expect(conversation).toMatchObject({
      conversationId: 'c1',
      platform: 'claude',
      accountId: 'org-1',
      accountName: 'Personal',
    });
    expect(conversation.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('throws when the conversation id is not found in the listing, rather than guessing', async () => {
    setClaudeLocation('missing');
    stubFetch({
      '/api/organizations/org-1/chat_conversations': CONVERSATIONS,
      '/api/organizations': ORGS,
    });

    await expect(fetchConversationForRepair('missing')).rejects.toThrow(/not found/);
  });
});

describe('registerArchiveDiscoveryListener', () => {
  function capturedListener() {
    return vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: ArchiveDiscoverResponse) => void
    ) => boolean;
  }

  beforeEach(() => {
    resetLocation();
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  });

  it('ignores messages from another tab (not the popup/background)', () => {
    registerArchiveDiscoveryListener();
    const sendResponse = vi.fn();

    const kept = capturedListener()(
      { action: 'archiveDiscover' },
      { id: chrome.runtime.id, tab: { id: 1 } } as chrome.runtime.MessageSender,
      sendResponse
    );

    expect(kept).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores messages with a different action', () => {
    registerArchiveDiscoveryListener();
    const sendResponse = vi.fn();

    const kept = capturedListener()(
      { action: 'chatSync' },
      { id: chrome.runtime.id, tab: undefined } as chrome.runtime.MessageSender,
      sendResponse
    );

    expect(kept).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('responds with the discovered conversations for a matching request from the popup', async () => {
    setClaudeLocation('c1');
    stubFetch({
      '/api/organizations/org-1/chat_conversations/c1': DETAIL,
      '/api/organizations/org-1/chat_conversations': CONVERSATIONS,
      '/api/organizations': ORGS,
    });
    registerArchiveDiscoveryListener();
    const sendResponse = vi.fn();

    const kept = capturedListener()(
      { action: 'archiveDiscover' },
      { id: chrome.runtime.id, tab: undefined } as chrome.runtime.MessageSender,
      sendResponse
    );

    expect(kept).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const response = sendResponse.mock.calls[0][0] as ArchiveDiscoverResponse;
    expect(response.success).toBe(true);
    if (response.success) {
      expect(response.conversations).toHaveLength(1);
      expect(response.failures).toEqual([]);
    }
  });

  it('responds with an error when discovery fails', async () => {
    setNonClaudeLocation('gemini.google.com');
    registerArchiveDiscoveryListener();
    const sendResponse = vi.fn();

    capturedListener()(
      { action: 'archiveDiscover' },
      { id: chrome.runtime.id, tab: undefined } as chrome.runtime.MessageSender,
      sendResponse
    );

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    const response = sendResponse.mock.calls[0][0] as ArchiveDiscoverResponse;
    expect(response.success).toBe(false);
  });
});
