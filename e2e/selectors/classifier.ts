/**
 * Selector validation result classifier.
 *
 * Classifies raw selector match results into PASS/WARN/FAIL categories.
 * WARN includes both the failed primary and working fallback for debugging.
 */

import type { BaselineComparison } from './baseline';

export interface SelectorResult {
  platform: string;
  group: string;
  name: string;
  selector: string;
  /** 0 = primary, 1+ = fallback */
  index: number;
  matchCount: number;
}

export interface WarnDetail {
  /** The primary selector that failed (matchCount === 0) */
  failedPrimary: SelectorResult;
  /** The first fallback selector that matched */
  workingFallback: SelectorResult;
}

export interface DeadMiddleDetail {
  /** A non-primary selector (index >= 1) that failed while a sibling matched */
  dead: SelectorResult;
  /** A selector in the same group that is currently matching, for context */
  liveSibling: SelectorResult;
}

export interface ClassificationResult {
  pass: SelectorResult[];
  warn: WarnDetail[];
  /**
   * Non-primary entries (index >= 1) that are dead while some other entry in
   * the same group still matches. Distinct from `warn`: a dead primary means
   * "promote the fallback"; a dead middle entry means "repair that specific
   * fallback" — the group still passes overall (a later entry carries it),
   * so this rot would otherwise be invisible until every remaining entry
   * also dies.
   */
  deadMiddle: DeadMiddleDetail[];
  /** All selectors failed — includes the primary's metadata */
  fail: SelectorResult[];
  /** lost / new_selector / removed — must fail the run (baseline contract) */
  baselineBlocking: BaselineComparison[];
  /** degraded — reported for observability, not enforced */
  baselineAdvisory: BaselineComparison[];
}

/**
 * Classify selector results into PASS / WARN / FAIL.
 *
 * - PASS: primary (index=0) has matches
 * - WARN: primary failed but a fallback matched
 * - FAIL: all selectors in the group have zero matches
 * - DEAD MIDDLE: a non-primary entry failed while some other entry (primary
 *   or fallback) in the same group still matches
 */
export function classifyResults(
  results: readonly SelectorResult[],
  baselineComparisons: readonly BaselineComparison[] = []
): ClassificationResult {
  const byName = new Map<string, SelectorResult[]>();
  for (const r of results) {
    const key = `${r.platform}:${r.group}:${r.name}`;
    const list = byName.get(key) ?? [];
    list.push(r);
    byName.set(key, list);
  }

  const pass: SelectorResult[] = [];
  const warn: WarnDetail[] = [];
  const deadMiddle: DeadMiddleDetail[] = [];
  const fail: SelectorResult[] = [];

  for (const [, items] of byName) {
    const primary = items.find(i => i.index === 0) ?? items[0];
    const anyMatch = items.some(i => i.matchCount > 0);

    if (primary.matchCount > 0) {
      pass.push(primary);
    } else if (anyMatch) {
      const fallback = items.find(i => i.matchCount > 0)!;
      warn.push({
        failedPrimary: primary,
        workingFallback: fallback,
      });
    } else {
      fail.push(primary);
    }

    // A group that isn't a total FAIL can still be hiding rot: any non-primary
    // entry that has gone dead is masked by whichever sibling still matches
    // (the primary if it's alive, or a later fallback otherwise). Surface
    // every such entry — not just index 0 — so a middle fallback dying
    // doesn't sit undetected until the whole group fails.
    if (anyMatch) {
      const liveSibling = items.find(i => i.matchCount > 0)!;
      for (const item of items) {
        if (item.index !== 0 && item.matchCount === 0) {
          deadMiddle.push({ dead: item, liveSibling });
        }
      }
    }
  }

  const baselineIssues = baselineComparisons.filter(c => c.status !== 'match');
  const baselineBlocking = baselineIssues.filter(c => c.status !== 'degraded');
  const baselineAdvisory = baselineIssues.filter(c => c.status === 'degraded');

  return { pass, warn, deadMiddle, fail, baselineBlocking, baselineAdvisory };
}
