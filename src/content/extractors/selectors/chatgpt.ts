/**
 * CSS Selectors for ChatGPT (chatgpt.com)
 *
 * Selectors are ordered by stability (HIGH → LOW)
 * @see DES-003-chatgpt-extractor.md Section 5.3.2
 * @see docs/adr/005-shared-selector-modules.md
 */

import type { SelectorGroup } from './types';

export const SELECTORS = {
  // Conversation turn (each Q&A pair)
  // ChatGPT changed from <article> to <section> in 2026-03; the article
  // variants matched nothing on the live site by 2026-07 and were removed
  // (the baseline contract rejects zero-match entries).
  // ChatGPT replaced the turn markup again in 2026-09 (an app-shell overhaul:
  // data-app-shell-*, WorkspaceContent-*). Measured live 2026-09-26 on two
  // conversations: EVERY pre-2026-09 selector below matches zero elements, so
  // extraction returned [] and auto-sync silently no-opped while the icon read
  // "synced". The unit fixtures still build the old DOM, so the suite cannot
  // see this class of break -- only `nix run .#e2e-selectors` can.
  // The unit key encodes turn index AND role: `fallback-turn-<n>:<m>:<role>`.
  // Older variants are kept below rather than deleted: only one account on one
  // UI build has been observed, and ChatGPT has A/B'd layouts before.
  conversationTurn: [
    '[data-content-search-unit-key]', // Current structure, 2026-09 (HIGH)
    'section[data-turn-id]', // Pre-2026-09 structure (HIGH)
    'section[data-testid^="conversation-turn"]', // Pre-2026-09 test attr (MEDIUM)
  ],

  // User message
  userMessage: [
    '[data-user-message-bubble="true"] .whitespace-pre-wrap', // Current, 2026-09 (HIGH)
    '[data-message-author-role="user"] .whitespace-pre-wrap', // Structure (HIGH)
    'section[data-turn="user"] .whitespace-pre-wrap', // Current structure (HIGH)
    '.user-message-bubble-color .whitespace-pre-wrap', // Style (MEDIUM)
  ],

  // Assistant message
  assistantResponse: [
    // The per-message container also carries the platform message id in
    // data-chatgpt-selection-message-id -- the source_id that tier-1 identity
    // wants and that live sync does not currently persist. Not wired up here;
    // that changes the sync payload and is deliberately out of scope.
    '[data-chatgpt-selection-message-id]', // Current, 2026-09 (HIGH)
    '[data-message-author-role="assistant"] .markdown.prose', // Structure (HIGH)
    'section[data-turn="assistant"] .markdown.prose', // Current structure (HIGH)
    '.markdown.prose.dark\\:prose-invert', // Style (MEDIUM)
  ],

  // Markdown content
  // 2026-09: ALL THREE of these match zero -- no `.prose`/`.markdown` class
  // survives the overhaul. Deliberately NOT repaired here. extractAssistantContent
  // tries markdownContent first and only falls back to assistantResponse; the
  // fallback path is repaired and verified working, whereas pointing this at the
  // new message container would silently re-activate selectAnswerBlocks() against
  // a reasoning-block structure nobody has examined. Fixing it blind is how you
  // trade a known-good fallback for an untested primary. Needs a conversation
  // with a "Thought for Ns" block to design against. See BACKFILL-SESSION-LOG JC-6.
  markdownContent: [
    '.markdown.prose', // Semantic (HIGH)
    '.markdown-new-styling', // Style (MEDIUM)
  ],

  // Scroll container for virtualized-conversation auto-scroll (ADR-017).
  // ChatGPT windows/evicts turns; the thread scroller carries data-scroll-root
  // and uses the `not-print:overflow-y-auto` token. IMPORTANT: the sidebar <nav>
  // also has `flex-1 flex-col overflow-y-auto` (plain, scrollTop 0), so a
  // class-only `overflow-y-auto` selector picks the nav and skips auto-scroll
  // (verified live 2026-07). Anchor on data-scroll-root; the `not-print:` prefix
  // uniquely distinguishes the thread scroller from the nav.
  // 2026-09: both prior entries match ZERO on the current DOM. That matters
  // more than it looks -- with no scroll container, ADR-017 auto-scroll cannot
  // run, so a long/virtualised conversation extracts only the visible window.
  // That is precisely the windowed-manifest shape reconcile()'s Guard 2 exists
  // to refuse, so the failure surfaces as "sync silently does nothing" rather
  // than as a scroll bug. Replacement verified live 2026-09-26: the element
  // genuinely scrolls (scrollHeight 1002 > clientHeight 835) and contains the
  // turns.
  scrollContainer: [
    '[data-app-action-timeline-scroll]', // Current thread scroller, 2026-09 (HIGH)
    '.thread-scroll-container', // Current class hook, 2026-09 (HIGH)
    '[data-scroll-root]', // Pre-2026-09 semantic root (HIGH)
    '[class*="not-print:overflow-y-auto"]', // Pre-2026-09 overflow token (MEDIUM)
  ],
} as const satisfies SelectorGroup;
