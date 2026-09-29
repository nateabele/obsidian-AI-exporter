# Sync observability and cross-producer identity — sub-project 1

**Date:** 2026-09-29
**Status:** spec, awaiting approval
**Branch:** `feat/sync-observability-and-identity` (off `feat/integrate-upstream-2.14.5`)

## 1. Why now

Three requests, and a defect found the same day that binds two of them together.

**The defect, measured.** Opening one backfilled ChatGPT conversation in the
browser caused the extension to append two duplicate blocks (`m-142`, `m-143`)
that already existed as backfill blocks `m-12` and `m-18`. All three
cross-producer alignment tiers failed:

| tier | why it failed |
|---|---|
| 1 — `source_id` | live ChatGPT blocks carry **0** source ids; backfill carries **9,317 / 9,317** |
| 3 — exact text | **one character.** See below. |
| 4 — exact suffix | `blockAlignment.js:229,235` require one text to *be* a suffix of the other; the divergence is mid-text |

**Corrected 2026-09-29, after measurement.** This spec originally asserted that
tier 3 failed because the DOM extractor drops the `- ` bullet prefixes the API
markdown carries. **That was wrong.** Bullet counts are identical on both
copies (4 and 4), and `normalizeForIdentity` already collapses `[ \t]+ → ' '`.

Running the real `normalizeForIdentity` (not a reimplementation of it) against
the real rows:

```
m-12 vs m-142   normalized 1621 vs 1622   ← ONE character
  @1464  backfill "practices.\n\n"   live "practices.\n\n\n"
m-18 vs m-143   normalized 1768 vs 1769
  @1425  backfill "farmers.\n\n"     live "farmers.\n\n\n"
```

The raw live markdown carries a whitespace-only line where backfill has none.
Normalization trims each line, turning that into an empty line — so the live
copy ends up with three consecutive newlines where backfill has two. Tier 3
misses on blank-line count alone.

**Consequence for this spec's priorities:** collapsing `\n{3,}` → `\n\n` in
`normalizeForIdentity` makes both pairs exact tier-3 matches. That one line is
the actual fix. `sourceId` (§6) remains worth doing — tier 1 is strictly
stronger than text comparison, and it is the only tier immune to *any* future
whitespace or rendering drift — but it is **not** what broke these, and this
spec should not have implied it was.

A corpus scan by the concurrent session (14,073 live blocks, 2,185
conversations, 36,300 same-role pairs, word-5-shingle Jaccard) found exactly
**2** cross-producer near-duplicate pairs — both of these, both J=1.0, both
closed by the collapse. Thirteen same-producer pairs at J≥0.98 are genuine
repeats (resent prompts), so similarity alone must not be the duplicate signal;
**cross-producer is the discriminator**.

The duplicates are **not** byte-identical, so the duplicate report cannot see
them. The safety net does not cover this failure mode.

**Why that gates a feature.** Request 2 (auto-sync on navigation) is the same
code path that produced the duplicates. Shipping it before tier 1 works would
turn a single observed instance into one per conversation browsed, across a
corpus that is now 1,477 ChatGPT conversations.

## 2. Intended outcome

The extension tells you what it is doing and why, follows you as you move
between conversations, and stops manufacturing duplicates while it does.

**Success criteria**

1. When a sync is attempted, the menu says so: when, what triggered it, and
   the outcome — including a full failure reason, not a truncated one.
2. Navigating between conversations starts a sync without requiring a DOM
   mutation to happen to fire one.
3. A live-synced ChatGPT block carries the platform's own message id, so tier 1
   can match it against the backfilled block for the same message.
4. Opening a backfilled ChatGPT conversation appends **zero** new blocks.
5. "Open transcript" either opens the note or explains why it cannot. It never
   silently does nothing.

**Explicitly out of scope** (sub-project 2, deliberately deferred):

- The durable event log surviving reloads (diagnostics stage 2).
- Companion-side correlation of attempts against what landed (stage 3) — it
  needs a mail-api endpoint the concurrent session owns, and designing against
  an interface that does not exist yet is how specs rot.

## 3. Build order, and why it is not grouped by subsystem

```
1. C + F   richer menu, and repair the inert Open-transcript entry
2. A       sourceId wiring
3. B       navigation-driven auto-sync
```

C comes first **so that A is observable when it lands**. The menu will show
whether blocks matched or were appended, so the alignment fix is verified by
watching it work rather than by trusting this document. That inverts the error
this codebase keeps making: our own ChatGPT repair was recorded as verified
because it extracted four turns correctly from one mounted window.

## 4. C — richer icon menu

**What exists.** `buildMenuEntries` (`sync-icon.ts:470-530`) renders entries
from three retained module-level values: `lastError`, `lastNotePath`,
`lastBlockedReason`, plus `currentSuggestions`. There is no record of *when*
anything was attempted, what triggered it, or what the server did with it.

**What to add.** One retained record, reset in `setIconContext` alongside the
existing retained state:

```ts
interface LastAttempt {
  at: number;                                    // Date.now()
  trigger: 'mutation' | 'navigation' | 'manual' | 'repair';
  outcome: 'sent' | 'noop' | 'blocked' | 'error' | 'needsFullContent';
  sent: number;                                  // blocks in the request
  appended: number;                              // from ChatSyncResponse
  superseded: number;
  detail: string | null;                         // full text, never truncated
}
```

Rendered as a non-interactive note at the top of the menu, in the style
`appendStateNote` already uses. `detail` carries the whole failure string:
today a connectivity error reaches the user only as a tooltip, and the tooltip
is one line.

`trigger` earns its place because of request 2 — once navigation can start a
sync, "did this fire because I navigated or because the page mutated?" becomes
a question you cannot answer from the outcome alone.

**Why not a toast.** Toasts are for events the user should see once. This is
state they need to interrogate after the fact, which is what the menu is for.

## 5. F — repair "Open transcript"

**The bug.** `sync-icon.ts:511` passes `lastNotePath ?? ''`, and bootstrap's
handler (`:868-877`) returns early on a falsy path. So with no sync this
session, the entry renders, is clickable, and does nothing — no toast, no log.

`ChatSyncResponse.notePath` (`types.ts:452`) means a *successful sync in this
page session* is the only source of the path.

**Fix, in two parts.**

1. When `lastNotePath` is null, the entry runs a sync first and opens the note
   the response names. That is the honest reading of what the user asked for:
   open *this* conversation in Obsidian.
2. If that sync cannot produce a path — unconfigured, offline, blocked — the
   entry reports the reason through the existing `showErrorToast` path rather
   than returning silently. A control that does nothing and says nothing is
   worse than a disabled one.

**Not doing:** resolving the path locally from the vault-path template. It
would duplicate server-side logic that already exists, and the two would drift.

## 6. A — ChatGPT `sourceId` wiring

**The shape of the identity problem.** `ConversationMessage.id` is set to the
turn key for *both* messages of a pair turn (`chatgpt.ts:384,392,420`), because
since 2026-09 one `div[data-turn-key]` holds a prompt and its answer. So `id`
cannot serve as per-message identity — the two blocks of a turn would share it.

**Both halves are available.**

- **User message:** the turn key *is* the user message uuid — upstream's own
  selector comment records this (`selectors/chatgpt.ts`: "`div[data-turn-key=<user message uuid>]`").
- **Assistant message:** `data-chatgpt-search-message-ids` on the answer unit.
  Upstream already reads it for image marker ids (`chatgpt.ts:526-531`,
  taking `.split(/\s+/)[0]`), so the access pattern is established, not invented.

**Changes.**

1. `ConversationMessage` gains `sourceId?: string` — a new field, *not* a reuse
   of `id`, for the reason above.
2. `ChatSyncBlock` (`types.ts:418`) gains `sourceId?: string`.
3. `buildManifest` (`manifest.ts:23-38`) passes it through to the block.
4. The ChatGPT extractor populates it on both messages of each turn.

**The hash does not change.** `buildManifest` hashes `` `${role} ${markdown}` ``
only. `sourceId` sits outside it, so this cannot churn a stored hash, cannot
invalidate a manifest, and cannot move an existing anchor. It is purely
additive.

**The server is already ready — verified here, not taken on report.**
`chatSyncService.js:317` reads `sourceId: block.sourceId || null` off incoming
blocks, and it is persisted on every write path (`:383`, `:389`, `:435`,
`:494`, `:652`, `:660`), with conflict handling at `:643`.

**Claude gets the same treatment if its DOM exposes an equivalent id.** Check
`data-index` or a message-level attribute; if there is none, Claude keeps
relying on tiers 3/4 and that is stated rather than silently assumed.

## 7. B — navigation-driven auto-sync

**Why it does not work today.** `establishAutoSyncContext` is called from
exactly one place: inside `runAutoSync` (`bootstrap.ts:749`), which fires only
from the debounced `MutationObserver`. Navigation is therefore *reconciled*
when a sync happens and never *causes* one. Navigate to a conversation that
then sits still and nothing happens at all.

**The mechanism already exists in the tree.** `startConversationWatcher`
(`conversation-watcher.ts:32`) takes `{ initialKey, getKey, onChanged, intervalMs }`
and calls `onChanged` once per id change. It arrived with the 2.14.5 merge and
is currently used only by the concurrent session's repair drain.

**Wiring.** Start one watcher in `initialize()`, with
`getKey: () => getExtractor()?.getConversationId() ?? null`, and `onChanged`
calling `runAutoSync()`. Do not add a second poller — if the repair drain has
already started one, share it rather than duplicating the interval.

**Two guards this must not lose:**

- `establishAutoSyncContext` still runs inside `runAutoSync`, so a navigation
  arriving mid-flight is not swallowed. The watcher is an additional *trigger*,
  not a replacement for that reconciliation.
- `autoSyncInFlight` still guards overlap. A navigation during an in-flight
  sync must not race `previousManifest`.

**Ordering constraint:** B ships only after A is verified to append zero blocks
on a backfilled conversation. That is the whole point of §1.

## 8. Risks

| risk | mitigation |
|---|---|
| A does not actually fix alignment, and B then amplifies it | C ships first, so the menu shows appended-vs-matched counts. B is gated on an observed zero-append. |
| Navigation watcher fires on transient ids mid-load | `startConversationWatcher` already debounces by comparing ids, not hrefs; verify against a real SPA navigation, not a fixture. |
| Two pollers (ours + the repair drain) | Explicitly check for an existing watcher before starting one; the drain is the concurrent session's and may land first. |
| `LastAttempt` grows into a log | It is deliberately ONE record, reset per conversation. The durable log is sub-project 2. |
| 166 integration commits still unpushed | Not this spec's problem to solve, but it widens the single-machine window. Push remains outstanding. |

## 9. Verification

Unit tests for each piece, and then the check that actually matters:

**The end-to-end gate for A**, run the way the defect was found — open
`chatgpt_d73ed95a-6b16-4403-baf8-2b3ad0e3dadf` (141 backfill blocks, and now 2
duplicates from the observed failure) and confirm a sync appends **zero** new
blocks and sets `source_id` on the live-matched ones.

Measure it in the database, not in the icon:

```sql
SELECT producer, COUNT(*), SUM(source_id IS NOT NULL)
FROM chat_blocks WHERE conversation_id = '<id>' GROUP BY producer;
```

A green suite is not evidence here. The suite builds the DOM it asserts
against, so it cannot see whether the extractor reads a real page — which is
precisely how the repair this merge replaced came to be recorded as verified.

**Cleanup:** the two duplicate blocks from the observed failure (`m-142`,
`m-143`) should be removed before the zero-append test, or they will make a
correct run look like it changed nothing.
