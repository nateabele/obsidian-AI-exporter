import { describe, it, expect, afterEach } from 'vitest';
import { buildManifest, diffBlocks } from '../../src/content/manifest';
import { htmlToMarkdown, escapeUserText } from '../../src/content/markdown-rules';
import { generateHash } from '../../src/lib/hash';
import { ChatGPTExtractor } from '../../src/content/extractors/chatgpt';
import {
  loadFixture,
  clearFixture,
  resetLocation,
  setChatGPTLocation,
  createChatGPTConversationDOM,
} from '../fixtures/dom-helpers';
import { createChatGPT2026Page } from '../fixtures/chatgpt-2026-09-dom';
import type { ConversationMessage } from '../../src/lib/types';

const messages: ConversationMessage[] = [
  { id: '1', role: 'user', content: 'first', index: 0 },
  { id: '2', role: 'assistant', content: 'second', index: 1 },
];

describe('buildManifest', () => {
  it('produces one hash per message, in order', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(manifest).toHaveLength(2);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].role).toBe('user');
    expect(blocks[0].hash).toBe(manifest[0]);
  });

  it('is deterministic for identical input', () => {
    expect(buildManifest(messages).manifest).toEqual(buildManifest(messages).manifest);
  });

  it('changes the hash when message content changes', () => {
    const edited = [{ ...messages[0], content: 'changed' }, messages[1]];
    expect(buildManifest(edited).manifest[0]).not.toBe(buildManifest(messages).manifest[0]);
  });

  it('converts an assistant HTML block (paragraphs, lists, bold, code fence) to markdown', () => {
    const html =
      '<p>Here is a <strong>list</strong>:</p><ol><li>one</li><li>two</li></ol>' +
      '<pre><code>const x = 1;</code></pre>';
    const { blocks } = buildManifest([{ id: '1', role: 'assistant', content: html, index: 0 }]);
    expect(blocks[0].markdown).not.toContain('<p>');
    expect(blocks[0].markdown).not.toContain('<strong>');
    expect(blocks[0].markdown).not.toContain('<pre>');
    expect(blocks[0].markdown).toContain('**list**');
    expect(blocks[0].markdown).toContain('1.  one');
    expect(blocks[0].markdown).toContain('```');
    expect(blocks[0].markdown).toContain('const x = 1;');
  });

  it('escapes user content instead of converting it as HTML', () => {
    const raw = 'plain <em>text</em> pasted by the user';
    const { blocks } = buildManifest([{ id: '1', role: 'user', content: raw, index: 0 }]);
    expect(blocks[0].markdown).toBe(escapeUserText(raw));
  });

  it('hashes the converted/escaped text, not the raw content', () => {
    const html = '<p>Here is a <strong>list</strong></p>';
    const { blocks } = buildManifest([{ id: '1', role: 'assistant', content: html, index: 0 }]);
    const converted = htmlToMarkdown(html);
    expect(blocks[0].markdown).toBe(converted);
    expect(blocks[0].hash).toBe(generateHash(`assistant ${converted}`));
    expect(blocks[0].hash).not.toBe(generateHash(`assistant ${html}`));
  });
});

describe('diffBlocks', () => {
  it('returns nothing when the manifest is unchanged', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(diffBlocks(manifest, manifest, blocks)).toEqual([]);
  });

  it('returns only appended blocks when the previous manifest is a prefix', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(diffBlocks([manifest[0]], manifest, blocks)).toHaveLength(1);
  });

  it('returns blocks from the divergence point onward', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(diffBlocks(['different'], manifest, blocks)).toHaveLength(2);
  });

  it('returns every block when there is no previous manifest', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(diffBlocks([], manifest, blocks)).toHaveLength(2);
  });

  it('returns an empty array when the previous manifest is longer than the current one (truncation)', () => {
    const { manifest, blocks } = buildManifest(messages);
    expect(diffBlocks([...manifest, 'extra-hash'], manifest, blocks)).toEqual([]);
  });
});

/**
 * ChatGPT's 2026-09 layout (issue #515) puts a user prompt AND its answer in
 * ONE `div[data-turn-key]`, where the layout it replaced gave each message a
 * turn of its own. The manifest is the only thing the companion listener can
 * line a fresh sync up against what it already stored, and a hash covers
 * `role` + converted markdown — so if the new turn model ever collapsed a pair
 * turn into a single block, every hash from the first divergence onward would
 * change, and the conversations stored under the old layout would re-append
 * instead of appending. Pinned here rather than in the extractor tests because
 * the invariant is about BLOCKS, which is what the server compares.
 */
describe("buildManifest over ChatGPT's 2026-09 pair turns (issue #515)", () => {
  afterEach(() => {
    clearFixture();
    resetLocation();
  });

  it('emits one block per message, in role order, hashed as the pre-2026-09 layout hashed it', () => {
    setChatGPTLocation('6789abcd-ef01-2345-6789-abcdef012345');

    // Two turns, each holding a prompt AND its answer — the 2026-09 shape.
    loadFixture(
      createChatGPT2026Page([
        { key: 'u-1', user: 'First question', answers: ['<p>First answer</p>'] },
        { key: 'u-2', user: 'Second question', answers: ['<p>Second answer</p>'] },
      ])
    );
    const pairTurns = buildManifest(new ChatGPTExtractor().extractMessages());

    expect(pairTurns.blocks.map(b => b.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(pairTurns.blocks.map(b => b.markdown)).toEqual([
      'First question',
      'First answer',
      'Second question',
      'Second answer',
    ]);

    // The same conversation in the layout the stored blocks were produced
    // from: four turns, one message each. Same manifest, hash for hash.
    clearFixture();
    loadFixture(
      createChatGPTConversationDOM([
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: '<p>First answer</p>' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: '<p>Second answer</p>' },
      ])
    );
    const oneMessagePerTurn = buildManifest(new ChatGPTExtractor().extractMessages());

    expect(pairTurns.manifest).toEqual(oneMessagePerTurn.manifest);
  });
});
