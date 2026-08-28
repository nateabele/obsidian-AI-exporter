import { describe, it, expect } from 'vitest';
import { walkFromLeaf } from '../../../src/content/archive/walk';

type N = { id: string; parent: string | null };
const graph = (...ns: N[]) => new Map(ns.map((n) => [n.id, n]));

describe('walkFromLeaf', () => {
  it('returns root-to-leaf order', () => {
    const g = graph({ id: 'a', parent: null }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' });
    expect(walkFromLeaf(g, 'c', (n) => n.parent).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('follows only the active branch, ignoring abandoned regenerations', () => {
    const g = graph(
      { id: 'a', parent: null },
      { id: 'b', parent: 'a' },
      { id: 'abandoned', parent: 'a' },
      { id: 'c', parent: 'b' },
    );
    expect(walkFromLeaf(g, 'c', (n) => n.parent).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a cycle instead of hanging', () => {
    const g = graph({ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' });
    expect(() => walkFromLeaf(g, 'a', (n) => n.parent)).toThrow(/cycle/i);
  });

  it('returns an empty array for an unknown leaf', () => {
    expect(walkFromLeaf(graph({ id: 'a', parent: null }), 'nope', (n) => n.parent)).toEqual([]);
  });
});
