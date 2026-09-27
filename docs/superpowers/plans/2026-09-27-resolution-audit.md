# Resolution audit — upstream 2.14.5 merge

Audit of merge `760b715` + fix `8c79dcb` against the pre-merge fork tip `00dd4d2`.
Question: did the resolution silently drop behaviour from either side?

## Method

Two independent passes, because they fail differently:

1. **Mechanical symbol sweep** (this document): every `export function`,
   `export const`, `export interface` and `export type` present at `00dd4d2`,
   checked for whether the name still resolves anywhere in `src/`. Catches a
   symbol that vanished. Cannot judge whether a replacement is adequate.
2. **File-level review** (Task 1's reviewer): every file upstream touched since
   the fork point, scanned for lines removed between `af49133` and `760b715`.
   Catches upstream behaviour dropped by an `--ours` resolution. Reported in the
   Task 1 review.

Neither alone is sufficient. The sweep found one item the file-level pass did
not name; the file-level pass found two Importants the sweep could not see,
because both were *live code with no consumer* rather than missing symbols.

## Sweep results

| check | result |
|---|---|
| `export function` at `00dd4d2` no longer resolving in `src/` | **none** |
| `src/` files present at `00dd4d2`, absent now | **none** |
| `export const` / `interface` / `type` no longer resolving | **1 — `SCROLL_TIMEOUT`** |

### `SCROLL_TIMEOUT` — legitimate upstream replacement, not a loss

`constants.ts:186` at `00dd4d2` defined a single fixed deadline,
`SCROLL_TIMEOUT = 30000`, used by `extractors/base.ts`, `extractors/gemini.ts`
and `lib/scroll-manager.ts`.

Upstream's #453 replaced it with a two-deadline model, both user-configurable:
`SCROLL_IDLE_TIMEOUT` (15 000 ms idle) and `SCROLL_MAX_TIMEOUT` (300 000 ms
absolute cap), with `DEFAULT_SCROLL_IDLE_TIMEOUT_SEC` / `DEFAULT_SCROLL_MAX_TIMEOUT_SEC`
as the settings defaults. Verified wired at `scroll-manager.ts:50-51`.

All three former users are files this fork changed by **0 lines** since the fork
point, so the merge took upstream's versions, which use the new model. The
replacement is strictly better than what it replaced: a fixed 30 s cap became a
15 s idle deadline with a 300 s ceiling, and both are user-settable.

**Note on why the sweep flagged it and the file-level pass did not:** the file
this symbol lived in (`constants.ts`) was resolved as an additive union with
*zero* removed lines from upstream's side, so a removals-based scan sees nothing.
The symbol disappeared from our side, which only a symbol-level check sees.

## What the file-level pass found that the sweep could not

Both Task 1 Importants were **live code with no consumer** — every symbol still
present, so the sweep is blind to them by construction:

1. **Upstream #376 regressed.** `OutputResult.warning` had a producer
   (`obsidian-handlers.ts:230`) and a forwarder (`output-handlers.ts:113`) but no
   consumer, because `displaySaveResults` was resolved to ours. Image-write
   failures were silent. Fixed in `8c79dcb` (`bootstrap.ts:919-932`).
2. **Readiness selector matched zero.** `bootstrap.ts` held its own literal,
   which scored **0** against the ChatGPT 2026-09 DOM the merge adopted (the
   derived selector scores 2 on the same fixture; the stale 2026-07 fixture
   reverses it, 11 vs 0). Cost a 10 000 ms timeout awaited before the sync icon
   was injected, on a default auto-sync platform. Fixed in `8c79dcb`
   (`bootstrap.ts:14`, `:150`, `:160`).

## Feature-line integrity

| area | result |
|---|---|
| `companion-client.ts`, `sync-icon.ts`, `manifest.ts`, `archive/*` | zero removed lines vs `00dd4d2` |
| settings round-trip | intact — **three** keys, not two: `companionUrl`, `autoSyncPlatforms`, `companionToken`, each complete across schema default, normaliser, pass-through, popup read, popup write, type |
| `chatSync` / `chatBackfill` message routing | intact; `saveToOutputs` widened to include `ErrorResponse` |
| `BYTES_PER_MIB` / `MAX_CONTENT_SIZE` | correct; the overloading existed on *our* side and ADR-038's replacement is live at `output-handlers.ts:282` |
| stale ChatGPT selector references in feature-line code | none — the archive adapters read JSON, not the DOM |

## Deferred, with rulings

- `PLATFORM_ROOT_SELECTORS` keeps `#app-container` / `#__next`, which upstream
  deleted as verified-absent. Harmless — `document.body` is the real fallback.
- `src/content/sync-status.ts` is unreachable. It is **upstream's** badge status
  model, not feature-line code (the task brief said otherwise; that was an error
  in the brief). Task 5 may consume it as the sync icon's status model.
- `migrateSettings()` (`storage.ts:171`) writes `secureSettings` without
  spreading, so it can wipe `companionToken`. **Pre-existing** — identical at
  `00dd4d2`. `saveSettings` was hardened against exactly this; `migrateSettings`
  never was.
- `message-watcher.ts` and `conversation-watcher.ts` have no callers. Intended:
  upstream called both from `presentSyncStatus()` (`af49133:bootstrap.ts:259,264`),
  the badge function deliberately deleted here. Task 5 re-wires them, and has a
  grep gate because **knip cannot see this** — its test-entry exemption (ADR-015)
  covers modules reachable only from their own tests.

## Conclusion

No feature-line behaviour was lost. Two pieces of upstream behaviour were lost
and are repaired. One symbol was replaced legitimately. Four items deferred with
rulings, one of which is pre-existing rather than merge-caused.

The generalisable finding: **a clean merge is not a safe merge.** Every loss here
arrived with no conflict marker, because conflict markers appear only where both
sides edited the same lines — and are absent precisely where one side deleted
something the other still depended on.
