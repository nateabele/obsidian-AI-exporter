import { describe, it, expect } from 'vitest';
import { buildManifest, diffBlocks } from '../../src/lib/manifest';
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
