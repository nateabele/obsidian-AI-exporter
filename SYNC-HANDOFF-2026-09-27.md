# Sync + Backfill — Session Handoff

**Date:** 2026-09-27 (rewritten late in the day; supersedes the earlier version of this
file, whose corpus figures are now obsolete)
**Branch:** `docs/backfill-findings-2026-09` (extension) · mail-api `main`
**Status:** **Claude corpus imported — 25 → 717 conversations.** ChatGPT sync repaired and
verified but still 4 of 1,459, blocked on an export that has never queued.

Continues `HANDOFF.md` (Stage 1) and `BACKFILL.md` (architecture). **`BACKFILL-HANDOFF.md`
(2026-09-04) is stale — it lists work as outstanding that merged on 09-14, and its corpus
sizing is wrong by more than an order of magnitude.** `BACKFILL-SESSION-LOG.md` holds the
judgement-call ledger.

---

## 1. Read this first

| | On platform | In `chat.db` | |
|---|---|---|---|
| Claude | ~706 exported | **717** | **done** |
| ChatGPT | **1,459** | **4** | blocked on export |

Claude exceeds its export count because the import added to conversations live sync had
already captured, and recovered at least one message the DOM never saw (§3).

**Nothing is pushed. Nothing is merged.** See §5 — this is now the largest single risk.

---

## 2. Numbers that corrected the record

Both platform counts in the older docs were wrong, from the same mistake: reading a
listing API's response as a total when it wasn't one.

- **ChatGPT's listing `total` is `offset + limit + 1`** — a has-more flag. Measured:
  `offset 0 limit 5 → 6`; `limit 100 → 101`; `offset 800 limit 1 → 802`. Offset IS
  honoured. Real count by binary search on first empty offset: **1,459**, not 29.
- **Claude has 698 conversations** in `nate@radify.io's Organization` (2024-06-21 →
  2026-09-26), not ~38. The second org (`Robot Summer Camp`) returns **403** — the exact
  case `df1e386` was written to survive, now confirmed real.
- `BACKFILL.md` §12's "~67 conversations… resumability is YAGNI" descends from the first
  error and sized an architecture decision against a number 20× too small.

---

## 3. The Claude import (2026-09-27)

Export at `/Users/nate/Downloads/claude-export/` — `conversations-000.zip`, a single
60.6 MB `conversations.json`. Imported via `bin/chat-import.js` over HTTP: **no browser, no
extension, no page session**, which is why it sidestepped every browser problem entirely.

**Run:** 704 attempted, 700 imported, 4 skipped `empty-conversation`, **0 failed** (+2 in a
prior canary batch = 702 of 706).

**Verified independently by a second session** (differently-written queries):

```
conversations   29 → 721      claude 25 → 717 · chatgpt 4 unchanged
blocks         159 → 4,812    live/backfill 4,733 · live/live 55 · superseded/live 24
source_id      4,733 / 4,733 on backfill blocks, 0 NULL
anchor_seq > block count      0 conversations
duplicate source_id in a conversation   0
duplicate report   2 pairs (both the canary, both tombstone-involving)
note_dirty=1   0          corpus_docs 721
```

**`source_id` at 4,733/4,733 is the headline.** That was the root enabler of the original
duplicate bug — live sync never persisted it, so tier 1 could never fire and text
comparison carried everything. Every Claude conversation now aligns on the platform's own
message id.

### The canary resolved, and one prediction missed usefully

`claude_b0bd160c-…` went **62/3/1 → 65/0/2**. All three former `producer='live'` blocks
converted to backfill. Duplicate report 3 → 2, `m-66` superseded, `last_synced_at` moved —
all as predicted.

**Missed: `anchor_seq` went 66 → 67 and `m-67` exists.** Verified genuinely new, not a
re-mint: its `source_id 019d7f7e-…` occurs **exactly once across all 4,812 blocks** (a
re-anchor would show two). 223 chars, assistant. The export held a message the vault never
had — almost certainly one the DOM never captured. A prediction that fails because reality
contained *more* than the model, and fails by adding rather than churning, is the good kind.

`m-1` and `m-66` are byte-identical at 7,543 chars, both now tombstones; `m-65` holds the
authoritative 8,919-char text. The 2 surviving report rows are permanent
tombstone-suffix pairs — reportable forever by design, not damage. **Do not chase the
duplicate report to zero.**

---

## 4. What is still broken or untested

### ChatGPT export has never queued — the only thing blocking 1,455 conversations

Requested twice. **After the six-digit email verification, ChatGPT returns you to
data-controls and the export modal must be confirmed a SECOND time.** Skipping it looks
exactly like success. Evidence it hasn't queued: no new "Your data export is in progress"
mail (the only one is 2026-09-13), no new "New sign-in to your OpenAI account".

Entering the verification code is credential entry — the permission classifier blocks it
(`[Security Weaken]`) and it should remain a human step.

### `live_hash` is 0 across all 4,812 blocks — the re-baseline path has never run

A backfill NULLs `live_hash`; only a `/sync` populates it. So `needsFullContent` →
re-baseline → `live_hash` — the mechanism the whole cross-producer identity workstream was
built for — **remains unexercised in production**, now across 717 conversations.

Newly testable: claude.ai works in this browser, and there are 716 non-canary backfilled
conversations. It requires enabling `claude` auto-sync, which was kept off to protect the
canary; that canary has now been consumed, so the constraint may be obsolete. **Confirm
with the parallel session before enabling it.**

### `chatImportSources/chatgpt.js` does not exist

The Claude adapter is on unmerged branch `feat/claude-import-source` (`cec8914`). Write the
ChatGPT one against a real archive — the contract forbids writing against a remembered
schema.

---

## 5. Merge and push state — the largest current risk

**Everything from today exists only on this machine, on branches with no remote.**

| Repo | Branch | State |
|---|---|---|
| extension | `docs/backfill-findings-2026-09` | **40 commits** ahead of main, **no remote branch** |
| extension | `main` | release 2.2.0 |
| mail-api | `main` | **281 unpushed** commits |
| mail-api | `feat/automatic-repair` | **unmerged**, 21 commits, complete (872/872) |
| mail-api | `feat/claude-import-source` | **unmerged**, 1 commit — the adapter that imported 700 conversations |

Merge strategy is a user decision and has not been made.

### Extension commits this session

| Commit | |
|---|---|
| `1264140` | e2e rot detection no longer hides behind a missing baseline; dead **middle**-entry detection; arch test that every selector group is e2e-covered |
| `4ce0bf8` | Retry queue: refusals no longer counted as sent; bounded attempts; `chrome.alarms` drain |
| `5109732` | Legacy queue migration — a silent-failure bug `4ce0bf8` itself introduced |
| `f810618` | Icon stops claiming `synced`: new `disabled`/`attention` states, `runAutoSync` gets a `catch`, baseline no longer advances on a windowed no-op |
| `cb4d0b7` | ChatGPT extractor repaired against the 2026-09 DOM overhaul |
| `dc57032` | CRXJS pinned to 3.0.0 (2.3.0 breaks on Vite 8); dev-mode config, serve path only |

---

## 6. The defect class this session was mostly about

An audit found **23 paths** where a sync ends without writing, and `SyncIconState` had no
member meaning "blocked" — `deriveState()` fell through to `synced` whenever no error was
retained. Only `unconfigured` was distinguishable from success.

Four independent instances surfaced in a day: the `autoSyncPlatforms` gate painting
`synced`; rotted extractors returning `[]`; a dead `scrollContainer` producing a windowed
manifest that Guard 2 correctly refuses; and a queue-format change that threw inside a
`catch` so retries were silently never queued. Every one was found by a human noticing a
number that hadn't moved.

**ChatGPT's rot is the canonical example.** Every selector matched zero after a 2026-09-24
DOM overhaul, while all 1412 tests passed — `test/fixtures/dom-helpers.ts` builds the OLD
DOM, so **selector rot is structurally invisible to `npm test`**. Only
`nix run .#e2e-selectors` against live pages can see it, and that never runs in CI.

### Current ChatGPT DOM hooks (verified live)

| Purpose | Selector |
|---|---|
| Turn container | `[data-content-search-unit-key]`, value `fallback-turn-<n>:<m>:<role>` |
| Role | attribute suffix — `$=":user"` / `$=":assistant"` |
| User text | `[data-user-message-bubble="true"] .whitespace-pre-wrap` |
| Assistant content | `[data-chatgpt-selection-message-id]` |
| Scroll container | `[data-app-action-timeline-scroll]` / `.thread-scroll-container` |

`markdownContent` is **deliberately left dead** — `extractAssistantContent` falls back to
`assistantResponse`, which is repaired and verified; repointing it would silently
re-activate `selectAnswerBlocks()` against a reasoning-block structure with no example to
design against.

**`data-chatgpt-selection-message-id` exposes the platform message id in the DOM** — the
`source_id` live sync never persists. Wiring it in is the strongest available fix for
cross-producer identity on ChatGPT. Deferred: it changes the sync payload.

---

## 7. Writing `chatImportSources/chatgpt.js`

Contract in `chatImportSources/index.js`:

```js
async function* readConversations(exportPath) -> ArchivedConversation
```

Four constraints, all of which fail **silently** if violated:

1. **Raw markdown only** — no vault-escaping, no `hash`. `chatImportRunner.toPayload()`
   escapes and hashes over the *escaped* text, mirroring the extension's
   `toBackfillRequest()` byte-for-byte. Pre-escaping makes a backfilled conversation
   disagree with its own later live syncs about every message.
2. **Iterate lazily** — do not read the archive into memory before the first yield.
3. **`conversationId` stable across runs** — it is the `--resume` checkpoint key.
4. **Catch per-record parse errors INSIDE the generator** — a thrown async generator cannot
   be resumed by the caller's `for await`, so one bad record silently ends the import.

**Reuse `chatImportSources/_stream.js`** (on `feat/claude-import-source`), which is
platform-agnostic: `openExportStream()` handles zip (via `unzip -p`, no new dependency) /
directory / bare `.json`, and `iterateTopLevelArrayElements()` is a lazy, brace/string/
escape-aware scanner using `node:string_decoder` for multi-byte safety.

**Inherited bug fix, do not regress it:** breaking out of the `for await` early left the
spawned `unzip` running forever and the importer never exiting. `chatImportRunner` breaks
early for `--limit`, the consecutive-failure backstop AND systemic-stop — so early break is
the *normal* path. Fixed by killing the child on stream close.

### The rule that governs both adapters

**An export parser reproduces the extension adapter's output byte-for-byte; it does not
render the richest available text.** The export knows more than the DOM does, and every
extra thing it knows is a permanent cross-producer divergence.

Claude's case: messages carry both flat `.text` and structured `content[]` (2,380 thinking,
2,114 tool_use, 2,097 tool_result blocks). `.text` was chosen because `claude.ts:256` is
`markdown: m.text`.

ChatGPT's equivalent is already codified at `src/content/archive/chatgpt.ts:152-158` — drop
any node whose `content.parts` is not an array (`content_type: 'code'`, `'thoughts'`; the
`author.role` filter can't catch them because their role genuinely is `assistant`), and
join only string parts with `\n\n`. Walk from `current_node` via `parent`; keep only
`author.role ∈ {user, assistant}`; `sourceId = node.id`.

---

## 8. Traps

- **Never rebuild after asking for an extension reload.** Vite emits content-hashed
  filenames and deletes the old one; the loaded extension 404s on a file that no longer
  exists. Symptom is **no content script at all** — no icon, no logs — indistinguishable
  from the extension being uninstalled. One console error is the only tell. *(Committed
  twice this session, the second time after logging it.)*
- **The browser is Dia**, not Brave or Chrome. Reports Chromium brands with a Google vendor
  string and no `navigator.brave`, which reads as Chrome. The exporter is also present in
  Brave profiles on disk, which misleads.
- **Dia's AppleScript is read-only for activation** — `set active tab index` and
  `set index of window` are both rejected. `make new window` works and comes to the front;
  it is the only reliable way to put a page in front of the user.
- **CRXJS must be ≥3.0.0 with Vite 8.** `^2.0.0-beta.23` resolves to 2.3.0, which logs
  `Unknown input options: platform` / `[PARSE_ERROR]` and never writes
  `vendor/vite-client.js`. HMR cannot work; the extension loads as if uninstalled.
- **Dev mode needs the vite process alive** — it dies with the session.
- **Do not restart mail-api during an import.** Every request sets `deferIndex: true` and
  that queue is in-memory; a restart silently loses queued indexing for already-written
  notes.
- **Back up `chat.db` with `sqlite3 .backup`, never `cp`** — it is WAL-mode, and `cp` once
  captured 29 of 109 blocks.
- **`e2e/baselines/` is gitignored and empty**, so the baseline half of rot detection is
  unavailable on a fresh checkout. `1264140` fixed the assert ordering so live-DOM findings
  still report, but the contract only works once seeded.
- **e2e never runs in CI** — CI is lint, format, test:coverage, build.
- Five selector groups have **no fallback**: gemini `DEEP_RESEARCH.panel`, perplexity
  `markdownContent`/`deepResearchCard`/`citationSpacer`, notebooklm `markdownContent`.
- **`#__next` is dead on every platform** that declares it. It lives only in
  `PLATFORM_ROOT_SELECTORS` (`bootstrap.ts:58-64`), is in no `SelectorGroup`, and is
  validated by nothing. `main` carries all of them alone.

---

## 9. Disproved — do not re-chase

- **claude.ai's renderer death is NOT the extension's fault.** Measured with the content
  script provably not running (a stale-asset 404) and claude.ai still died. Selector rot,
  the `document.body` observation fallback, and `isCompanionConfigured` flipping
  false→true are all ruled out.
- **The `document.body` fallback does not fire for Claude.** Confirmed live:
  `[G2O] Using optimized observation root: main`.
- **claude.ai loads fine in this browser now** — `/new` and a real conversation both render
  and execute JS, with Claude's own selectors matching.
- **An export-sourced import of the canary was NOT a harder alignment case**, as was
  argued. Tier 1 carried it: all 62 stored `source_id`s appear in the export. The
  reasoning was sound, the premise wasn't, and only the comparison could settle it.

---

## 10. Parallel workstream

A second session (`backfill`) owns the cross-producer identity work and the automatic-repair
design (mail-api `feat/automatic-repair`, spec `303cc44`), landing in
`src/content/bootstrap.ts`, `src/lib/companion-client.ts` and `src/content/archive/`.
**Coordinate before editing those.**

Their Producer B enumerates from `chat_conversations` — it repairs the known and never
discovers the unknown, so it does not cover ChatGPT's 1,455 unsynced conversations.

Constraints that were live during the canary (verify whether still needed now it is spent):
keep `claude` auto-sync unchecked; do not touch `chatSyncService.js`, `blockAlignment.js`,
or the sync payload.

---

## 11. Next steps, in order

1. **Complete the ChatGPT export** — Export → Confirm → code → **Confirm again**. Watch for
   "Your data export is in progress". **Download link expires in 24 hours.**
2. **Write `chatImportSources/chatgpt.js`** (§7), `--dry-run` first, expect ~1,459.
3. **Run the ChatGPT import** with `--resume`.
4. **Exercise the durability path** — enable `claude` auto-sync, open any non-canary
   backfilled conversation, confirm `needsFullContent` → re-baseline → `live_hash`
   populated. This is the last untested mechanism in the identity work. Coordinate first.
5. **Decide merge and push** (§5). Forty extension commits and an import adapter exist on
   no remote.

### Worth doing, not urgent

- Wire `data-chatgpt-selection-message-id` into `source_id` on live sync — gives ChatGPT
  tier-1 identity, as the Claude import just gave Claude.
- Repair `markdownContent` once a reasoning-block conversation exists to design against.
- Decide `#__next`: repair or delete, and bring `PLATFORM_ROOT_SELECTORS` under e2e
  validation.
- Decide whether to commit `e2e/baselines/`.
- Measure per-conversation import latency — every estimate in these docs still stands in
  for it.
