import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverConversations, registerArchiveDiscoveryListener } from '../../../src/content/archive/discover';
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

    const conversations = await discoverConversations();

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: 'c1',
      platform: 'claude',
      accountId: 'org-1',
      accountName: 'Personal',
    });
    expect(conversations[0].messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(conversations[0].messages[0].hash).toBeTruthy();
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
