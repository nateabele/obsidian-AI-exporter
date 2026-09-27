import { describe, it, expect } from 'vitest';
import { buildManifest, diffBlocks } from '../../src/content/manifest';
import { htmlToMarkdown, escapeUserText } from '../../src/content/markdown-rules';
import { generateHash } from '../../src/lib/hash';
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
