/**
 * Both Claude and ChatGPT return a conversation as a TREE with a
 * designated active leaf, not a flat list. Claude's messages carry an
 * `index` field that invites treating them as ordered, but with
 * `tree=True` the response contains abandoned branches too and `index`
 * cannot disambiguate them. Walking parents from the active leaf is the
 * only correct reading, and it is identical for both platforms.
 */
export function walkFromLeaf<T>(
  nodes: Map<string, T>,
  leafId: string,
  parentOf: (node: T) => string | null
): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current) {
    if (seen.has(current)) {
      throw new Error(`Cycle detected in conversation tree at node ${current}`);
    }
    seen.add(current);
    const node = nodes.get(current);
    if (!node) break;
    chain.push(node);
    current = parentOf(node);
  }
  return chain.reverse();
}
