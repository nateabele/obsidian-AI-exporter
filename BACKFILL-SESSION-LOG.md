# Backfill + Auto-Sync Session Log

**Started:** 2026-09-26
**Mandate:** Make backfill exports work and sync with the auto-sync extension, keeping the
local index continuously up to date across Claude and ChatGPT, across all accounts.
Iterate; make judgement calls and log them; stop only on genuine blockers.

**Peer session:** `backfill` (uds:/tmp/cc-socks/73290.sock) — owns the Claude
cross-producer identity repair experiment on `claude_b0bd160c-…`.

---

## State at start (measured, 2026-09-26)

| | Claude | ChatGPT |
|---|---|---|
| Conversations in `chat.db` | 25 | 3 |
| Known to exist on platform | ~38 in org 1, plus a 2nd org | 29 (`total` from listing) |
| Blocks | 62 backfill + 85 live | 8 live |
| Most recent sync | 2026-09-25 | 2026-09-24 |

Corpus index: 28 transcripts — every stored conversation is indexed.

**Auto-sync works on both platforms.** Conversations appear as they are used — Claude
through 09-25, ChatGPT through 09-24. The "keep up to date with the *latest*" half of the
mandate is already satisfied. The gap is **historical backfill**.

---

## Judgement calls

### JC-1 — Use the in-browser "Import history", not the CLI + export archive

`BACKFILL-HANDOFF.md` §8 declares the in-browser driver abandoned in favour of
`bin/chat-import.js` reading a platform export archive. I am going the other way, for
reasons that did not hold when §8 was written:

- The CLI path is **blocked on an artifact that does not exist**. The Claude export needs a
  signed-in browser download behind a Cloudflare challenge, and §8 itself says the parser
  must not be written before the archive exists.
- The in-browser driver **still exists and is built**. `b2fd842` removes it but is
  unmerged; `src/popup/index.html:370-377` and `app.ts:142/657-663` are intact on
  `docs/backfill-findings-2026-09`, and `dist/` (built 2026-09-23) contains it. All five
  adapters are present under `src/content/archive/`.
- §8's five objections (loop in the popup, no streaming discovery, no pacing, no
  checkpoint, no abort on auth expiry) were sized against **600 conversations**. The actual
  remaining work is ~26 ChatGPT + ~13 Claude. At that scale none of the five is disqualifying.

**Cost if wrong:** a partial import that has to be re-run. Backfill is idempotent by
design (identity-based alignment, anchors preserved), so a re-run is cheap. Revisit if the
true conversation count turns out to be an order of magnitude higher than the listing says.

### JC-2 — Do not drive the shared browser while the peer holds it

Only one of the two connected browsers has the exporter:

```
9b3223cb  "Browser 1"  — no exporter extension
86be58d2  "Browser 2"  — exporter present, inUse: true
```

The peer is mid-experiment in `86be58d2` with an unspent pre/post baseline. Driving it
concurrently would consume their measurement exactly the way a stray auto-sync would. Work
is **serialised, not parallel**, by explicit agreement rather than by luck.

### JC-3 — Account provenance is a design question, not a bug to patch unilaterally

`account_name` is NULL on 27 of 28 conversations; the only populated one is the peer's
2026-09-04 repair. `b76aee9` made `/backfill` record the signed-in login, but live `/sync`
never carries it. The "tell accounts apart in one vault" property therefore holds only for
backfilled conversations.

This blocks the "across all accounts" half of the mandate, but the fix touches
`chatSyncService` and the extension's sync payload — both of which the peer is running an
experiment against. Raised with them rather than patched. **Open.**

---

## Timeline

- **2026-09-26 T0** — token pasted by user; baseline verified intact
  (`last_synced_at 2026-08-31T16:45:12.041Z`, `anchor_seq 66`, 62/3/1, `live_hash` 0/62,
  duplicate report 3 pairs). Repair had **not** run.
- Mandate widened to both platforms, all accounts. Coordination message sent to peer.

---

## 2026-09-26 — ChatGPT investigation. Three documented facts overturned.

### F-1 — ChatGPT has **1,459 conversations**, not 29 or 67

`BACKFILL.md` §12 records "ChatGPT: `total: 29`" and concludes "combined scale is ~67
conversations, not hundreds. Resumability and throttling can be cut as YAGNI."

Measured by binary search over `offset` (probe `limit=1`, find first empty offset):
**1,459 conversations.** Offset is genuinely honoured — six probes at six offsets returned
six distinct conversation ids, including a real one at offset 800.

### F-2 — the listing's `total` is not a count; it is `offset + limit + 1`

| request | `total` |
|---|---|
| offset 0, limit 5 | 6 |
| offset 0, limit 100 | 101 |
| offset 50, limit 1 | 52 |
| offset 800, limit 1 | 802 |

It is a has-more flag, not a cardinality. The 2026-08-27 survey read `total: 29` at
`limit=28` as "29 conversations"; that was this artifact. **We never knew the real count.**
`BACKFILL.md` §12 needs correcting.

### F-3 — ChatGPT's DOM changed; every extractor selector is dead, and it fails silently

On two separate conversations — including one that synced successfully on 2026-09-24 —
**all ten selectors in `src/content/extractors/selectors/chatgpt.ts` match zero elements**:
`section[data-turn-id]`, `section[data-testid^="conversation-turn"]`,
`[data-message-author-role]`, `.markdown`, `.markdown.prose`, `[data-scroll-root]`, and the
rest. The conversations render normally — verified by screenshot.

The failure is **silent**: `extractMessages()` finds zero turns, logs a console warning,
returns `[]`; `runAutoSync` bails; `settleIcon(true, …)` paints a non-error state. **The icon
reads `synced` while nothing syncs.** Same false-success shape as the gated no-op.

That is why ChatGPT is stuck at 3 conversations.

### The replacement structure (measured)

| Purpose | New hook |
|---|---|
| Turn container | `[data-content-search-unit-key]`, value `fallback-turn-<n>:<m>:<role>` |
| Role | attribute suffix — `[data-content-search-unit-key$=":user"]` / `$=":assistant"` |
| User text | `[data-user-message-bubble="true"]` → `.whitespace-pre-wrap` |
| Assistant content | `div[data-chatgpt-selection-message-id]` inside the unit |
| **Platform message id** | `data-chatgpt-selection-message-id` / `data-chatgpt-search-message-ids` |

ChatGPT also shipped an app-shell overhaul (`data-app-shell-*`, `WorkspaceContent-*`),
consistent with a broad UI release rather than an incremental tweak.

### JC-4 — revise JC-1: the in-browser driver is **not** adequate

JC-1 sized the in-browser import against ~98 ChatGPT conversations and judged §8's five
objections non-disqualifying. At **1,459** they are disqualifying, exactly as §8 argued. The
CLI + export-archive architecture was right; I was reasoning from a count that was an
artifact of F-2. Recorded as a reversal rather than edited away.

### JC-5 — fixing the ChatGPT selectors is in scope; touching `source_id` is not

Repairing `selectors/chatgpt.ts` (and `turnRole()`) restores extraction and is none of the
three files the peer asked me to leave alone. **In bounds.**

Wiring `data-chatgpt-selection-message-id` into `source_id` on live sync would change the
sync payload — peer constraint 3, and it invalidates their frozen prediction. **Deferred and
flagged**, not slipped in. It would give ChatGPT live-synced blocks tier-1 identity, which is
the strongest fix available for the cross-producer problem, so it is worth doing *after* T2.

---

## 2026-09-26 — ChatGPT extractor repaired; zero-match audit

Prompted by the peer's suggestion after my ChatGPT finding: audit **every** selector
primary for zero matches, since a fallback chain hides rot until the fallbacks die too.

Audited live against a real conversation. Results:

| Group | Before | After fix |
|---|---|---|
| `conversationTurn` | **0 / 0** | 2 (`[data-content-search-unit-key]`) |
| `userMessage` | **0 / 0 / 0** | 1 (`[data-user-message-bubble="true"]`) |
| `assistantResponse` | **0 / 0 / 0** | 1 (`[data-chatgpt-selection-message-id]`) |
| `scrollContainer` | **0 / 0** | 1 (`[data-app-action-timeline-scroll]`) |
| `markdownContent` | **0 / 0 / 0** | still 0 — deliberate, see JC-6 |
| platform root | `main` ✓, `#__next` **0** | unchanged |

**`scrollContainer` was the consequential miss in my first pass.** With no scroll
container, ADR-017 auto-scroll cannot run, so a long/virtualised conversation extracts
only the visible window — the windowed-manifest shape Guard 2 refuses. It would present
as "sync silently does nothing", not as a scroll bug. Replacement verified to actually
scroll (scrollHeight 1002 > clientHeight 835) and to contain the turns.

### JC-6 — leave `markdownContent` dead rather than guess

All three match zero. **Not repaired.** `extractAssistantContent()` tries
`markdownContent` first and falls back to `assistantResponse`; the fallback is repaired
and verified extracting 8,264 chars of assistant HTML. Pointing `markdownContent` at the
new message container would silently re-activate `selectAnswerBlocks()` — the
reasoning-summary / "Thought for Ns" exclusion logic — against a structure I have not
seen an example of. That trades a verified fallback for an untested primary, which is
the exact defect shape this project keeps paying for. Needs a conversation containing a
reasoning block to design against. **Open.**

### Confirmed independently: `#__next` is dead on every platform

Peer found it for Claude; confirmed for ChatGPT. Both platform root lists are
`['main', '#__next']`, copy-pasted. `main` carries it alone — the redundancy is
illusory. Not changed (it is harmless while `main` holds, and deleting vs repairing is a
call worth making deliberately).

### Hypothesis I raised and the peer disproved

I proposed that claude.ai's renderer death came from `PLATFORM_ROOT_SELECTORS.claude`
rotting → `getObservationRoot()` falling back to `document.body` → whole-document
observation. Peer tested from the browser where claude.ai works: **`main` matches**, so
the fallback never fires. Mechanism ruled out. Recorded because a disproved hypothesis
is worth as much as a confirmed one — it removes selector rot from the suspect list for
that bug, leaving `isCompanionConfigured` false→true as the trigger with no known path.

### Status: ChatGPT fix is COMPLETE and awaiting one extension reload

Built, 1412 tests pass, lint clean, validated against live DOM (2 turns, both roles,
both content nodes). **Cannot take effect until the unpacked extension is reloaded** —
`chrome://extensions` is refused to browser automation. User action.

### GOTCHA — rebuilding after an extension reload 404s the content script

Sequence that bit us: user reloads the unpacked extension → I rebuild → Vite emits a new
content-hash filename and **deletes the previous one** → the loaded extension still
references the old name → `TypeError: Failed to fetch dynamically imported module:
chrome-extension://…/assets/index.ts-<oldhash>.js`.

The symptom is **not** an obvious error state: `document.querySelectorAll('[id*=g2o]')`
returns 0, no icon, no console output from the content script — it looks exactly like the
extension being uninstalled or broken, not like a stale asset reference. The only tell is
that one console error, which is easy to miss because the content script never logs its
usual `[G2O] Content script initializing`.

**Rule: finish all builds BEFORE asking for the reload, and never rebuild after one.** If a
rebuild happens, another reload is mandatory.

---

## Cohesive design: "No Silent Success"

**The pattern.** Three independent routes to *"the UI reports success while nothing was
written"* were found in one codebase in one day:

1. `runAutoSync` bails at the `autoSyncPlatforms` gate → `settleIcon(true, …)` paints a
   non-error state.
2. Rotted extractor selectors → `extractMessages()` returns `[]` → bail → same paint.
3. Dead `scrollContainer` → only the visible window is extracted → server Guard 2 refuses
   it as a possible virtualised window → `mode: 'noop'` → nothing written, icon normal.

Three is a design property, not three bugs. Each was found by accident, by a human noticing
a number that didn't move — never by the system saying so.

**Invariant to establish:** *a run that did not write must be distinguishable from a run
that did — at runtime, in the UI, and in the test suite.*

### L1 — Observability: make a miss visible

- `queryWithFallback` / `queryAllWithFallback` (`base.ts:527-541`, `:553-567`) return
  `null` / `[]` with **no log, no counter, and no record of which entry matched**. A primary
  dying behind a live fallback is, at runtime, identical to a healthy primary. This is the
  exact information loss that hid Claude's `conversationBlock` rot.
- `getObservationRoot()` (`bootstrap.ts:86-101`) falls back to `document.body` with **no log
  at all** — the only `console.debug` is on the success path.
- No extraction telemetry exists anywhere in `src/` (searched: `telemetry|selectorMiss|
  recordMiss|trackSelector` — zero hits).

### L2 — Surfacing: the icon must not claim success for a bail

`settleIcon(true, …)` is called on every early return. The `SyncIconState` vocabulary has no
state meaning *blocked* or *degraded* as distinct from *up to date*. Expected no-ops
(platform disabled) and genuine failures (extraction empty on a page that is plainly a
conversation) must not paint the same thing.

### L3 — Prevention: tests that can actually catch rot

The e2e system **already** detects dead primaries — better than assumed — but:
- it is **not in CI** (CI runs lint, format, test:coverage, build only);
- `e2e/baselines/` is **gitignored and empty**, so the baseline mechanism is unavailable on a
  fresh checkout;
- worse, the missing-baseline assert fires **before** the dead-primary assert, so a cold run
  reports "run baseline:update" while real rot sits undiagnosed in the attached report;
- `READY_SELECTORS.chatgpt_conv` in the spec is itself the rotted `section[data-turn-id]`,
  so a total ChatGPT miss trips the readiness-stall path and never reaches validation.

### Open items not yet assigned

- `PLATFORM_ROOT_SELECTORS` and `CONVERSATION_CONTAINER_SELECTOR` (`bootstrap.ts:58-64`,
  `:79-80`) are in **no** `SelectorGroup`, therefore in no baseline, validated by nothing.
  `#__next` lives only there and is dead on all three platforms that declare it.
- Five single-entry selector groups have no fallback at all: gemini `DEEP_RESEARCH.panel`,
  perplexity `markdownContent` / `deepResearchCard` / `citationSpacer`, notebooklm
  `markdownContent`.
- **Decision needed:** `e2e/baselines/` gitignored means rot detection degrades on every
  fresh checkout and in CI. Commit baselines (they become a shared contract that must be
  updated deliberately) or accept per-machine baselines and rely on the WARN path alone?
