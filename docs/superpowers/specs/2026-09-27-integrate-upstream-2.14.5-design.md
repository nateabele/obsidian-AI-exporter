# Integrating the companion-sync feature line onto upstream 2.14.5

**Date:** 2026-09-27
**Status:** spec, awaiting approval
**Branch:** `feat/integrate-upstream-2.14.5` (off local `main` @ `86a925b`)

## 1. Why

Local `main` is an 11-week-old fork. It was never recognised as one because the
handoff recorded "extension main: release 2.2.0" — a local fact that reads like a
current one.

```
merge-base   5486226   release 2.2.0    2026-07-07
local main   86a925b   2.2.0 + 42 commits (companion-sync feature line)
origin/main  af49133   release 2.14.5   149 commits ahead, pushed 2026-09-26
```

`git merge-base --is-ancestor origin/main main` is false: the histories have
diverged. Upstream shipped twelve minor releases in that window, including
independent repairs for the same 2026-09 platform rot this fork spent a day
fixing — and, in the ChatGPT case, a better-informed repair.

`sho7650/obsidian-AI-exporter` grants this account **READ**, so the 42 commits
were unpushable anywhere. That is now resolved: `nateabele/obsidian-AI-exporter`
exists (ADMIN), with `preserve/companion-sync-2.2.0-base` and tag
`pre-integration/2026-09-27` pushed to it.

## 2. Intended outcome

`nateabele/obsidian-AI-exporter` becomes a **permanent private fork** and the
daily driver: the companion-sync feature line, running on a current upstream
base, tracking upstream periodically for platform fixes. The feature line is
**not** destined for upstream, so history cleanliness matters only locally.

**Success criteria**

1. `git merge-base --is-ancestor origin/main <integration branch>` is true.
2. The companion-sync subsystem still works: companion client, sync icon, chat
   backfill, archive adapters, manifest/continuous sync.
3. Upstream's platform repairs are in force — ChatGPT (#524), Perplexity (#518),
   Claude auto-scroll (#500) — rather than this fork's superseded versions.
4. `nix run .#lint`, `.#test`, `.#build` pass, with lint at upstream's `error`
   severity and upstream's knip fitness function satisfied.
5. The extension loads and syncs a real conversation end-to-end.
6. The peer session's deferred `bootstrap.ts` hook has a stable base to land on.

**Explicit non-goals**

- Splitting the feature line into upstream-contributable PRs. Deferred with the
  fork decision; `preserve/` keeps that option alive.
- Repairing `markdownContent` or the `#__next` root selectors. Upstream already
  repaired `markdownContent`; `#__next` is a separate open question.
- Wiring `data-chatgpt-selection-message-id` into `sourceId`. It must be
  re-derived against upstream's replaced selector module, so it lands *after*
  this merge, as separate work.

## 3. Approach: one merge, upstream into our line

`git checkout feat/integrate-upstream-2.14.5 && git merge origin/main`.

Our history stays first-parent, which is the right shape for a fork that tracks
upstream, and each conflict is resolved exactly once. A 42-commit rebase would
re-resolve the same integration points repeatedly and would fight hardest over
the ChatGPT commits we intend to discard anyway.

The feature line is overwhelmingly **additive** — `companion-client.ts`,
`sync-icon.ts`, `manifest.ts`, `src/content/archive/*` do not exist upstream and
merge without conflict. Real conflict is confined to ~7 integration points out
of 27 touched files.

## 4. Resolution policy

Measured change volume since the fork point drives this:

| file | local Δ | upstream Δ | resolution |
|---|---|---|---|
| `src/content/extractors/chatgpt.ts` | 9 | **447** | **upstream** |
| `src/content/extractors/selectors/chatgpt.ts` | 42 | 51 | **upstream** |
| `e2e/selectors/*` | 65/37/6/3/87 | 1/17/24/11/100 | **upstream** |
| `src/lib/constants.ts` | 24 | 150 | upstream + re-add companion keys |
| `src/lib/storage.ts` | 33 | 117 | upstream + re-add companion settings |
| `src/lib/messaging.ts` | 12 | 58 | upstream + re-add chatSync messages |
| `test/background/index.test.ts` | 65 | 453 | upstream + re-add local cases |
| `src/content/bootstrap.ts` | **825** | 165 | **local**, replay upstream's 165 |
| `test/content/index.test.ts` | **1269** | 336 | **local**, replay upstream's 336 |
| `src/content/ui.ts` | 215 | 124 | **local** (see §5) |
| `src/popup/app.ts` | 238 | 147 | both — additive, different settings |
| `src/_locales/{en,ja}/messages.json` | 185/83 | 114/120 | both — union of keys |
| `src/lib/types.ts` | 208 | 86 | both — additive interfaces |
| `src/background/service-worker.ts` | 197 | 5 | local + upstream's 5 |
| `src/popup/index.html` | 122 | 73 | both — additive |
| `src/background/validation.ts` | 88 | 54 | both — additive |
| `vite.config.ts` | 70 | 11 | local (dev-mode config) |
| `src/manifest.json` | 11 | 8 | both — union |
| `package.json` | 2 | 17 | upstream **except** the CRXJS pin (§6) |
| `package-lock.json` | 434 | 3628 | **regenerate**, never hand-merge |

"upstream + re-add" means: take upstream's file wholesale, then re-apply the
feature line's additions on top, rather than resolving hunk-by-hunk.

### 4.1 Why ChatGPT goes to upstream wholesale

Upstream changed 447 lines where this fork changed 9. More importantly the two
fixes disagree about the DOM, and upstream is right:

- Upstream anchors turns on `div[data-turn-key]` and records that
  `fallback-turn-N` **is renumbered per mounted window**. This fork keyed on
  `[data-content-search-unit-key]`, whose value *is*
  `fallback-turn-<n>:<m>:<role>` — built on the value upstream measured as
  unstable, on the same day.
- Since 2026-09 **one turn holds the prompt and its answer** (#515). This fork
  read the `:role` suffix as a per-turn role discriminator.
- Upstream repaired `markdownContent` (`[data-markdown-text-style="assistant-message"]`);
  this fork deliberately left it dead for want of a reasoning-block example.
- Upstream warns `[data-conversation-role="assistant"]` is a visually hidden
  "ChatGPT said:" marker whose text must never be exported; this fork used a
  sibling container as the body fallback.
- The scroller is `flex-direction: column-reverse` (ADR-042): `scrollTop` is 0 at
  the bottom and negative upward. This fork found the element but not that.

This fork's repair extracted four turns correctly from one mounted window and was
recorded as verified. It was a fix verified against the state it was measured in
— the same silent-success shape as the icon painting `synced`, one layer down.

`src/content/archive/chatgpt.ts` is unaffected: it parses the export/API node
graph, not the DOM, and is local-only.

## 5. The sync-status affordance

Both lines independently built, then hardened, a sync-status surface:

- upstream `src/content/ui-badge.ts` + `ensureSyncAnchor`/`injectSyncButton`/
  `setButtonLoading` (#459, #468)
- local `src/content/sync-icon.ts` — seven states, menu, per-conversation repair,
  suggestions — plus ten hardening commits

**`sync-icon` wins.** Drop `ui-badge.ts`, `ensureSyncAnchor`, `injectSyncButton`
and `setButtonLoading`; `bootstrap.ts` resolves to the local wiring.

**But port the guarantees, not the code.** Upstream's badge commits encode fixes
for real bugs. Audit each against `sync-icon`:

| upstream guarantee | likely local equivalent | action |
|---|---|---|
| #459 watchers keep the badge honest while on screen | `3aafe99` settle on every exit path; `c76aedc` retain error across bail-outs | verify no exit path leaves a stale paint |
| #468 clear the badge when a newer message appears | `8cc684e` gate paints on per-conversation href; `d5bf5dd` reset retained detail on in-app nav | verify a *new message in the same conversation* clears state, not just navigation |

The #468 case is the one most likely to be a genuine gap: local's two fixes are
both keyed on conversation identity changing, whereas #468 fires when a new
message arrives within the same conversation. If `sync-icon` has no equivalent,
add one — that is a real bug this merge would otherwise import.

Orphaned exports are self-policing: upstream's knip fitness function (#475,
ADR-037) fails on unused exports, so anything left behind by this decision
surfaces as a lint failure rather than as dead code.

## 6. Toolchain: keep the local CRXJS pin

Upstream ships `@crxjs/vite-plugin: ^2.0.0-beta.23` **with** `vite: ^8.0.16`.
That range resolves to 2.3.0, which logs `Unknown input options: platform` /
`[PARSE_ERROR]` and never writes `vendor/vite-client.js` — the extension then
loads as if uninstalled. Upstream's CI runs lint, format, test:coverage and
build, never the dev server, which is why upstream has not noticed.

So local `dc57032` is **not** superseded: take upstream's `package.json` but
keep `@crxjs/vite-plugin: ^3.0.0` and the local `vite.config.ts` dev-mode
handling. Worth offering upstream later as an isolated fix.

`package-lock.json` is regenerated with `npm ci` after resolution, never merged.

## 7. Two upstream fitness functions the feature line has not faced

1. **Lint ratchet promoted `warn` → `error`** (#477, ADR-012): `max-lines` 800,
   `max-lines-per-function` 50, `max-depth` 4, `complexity` 15. Measured on the
   local tree: 5 violations, of which **only 2 are real work**.
   `perplexity.ts`, `append-utils.ts` and `scroll-manager.ts` were changed by
   this fork by **0 lines** since the fork point while upstream changed them by
   206 / 333 / 568 — so they are not collisions and the merge takes upstream's
   versions, which necessarily pass because upstream CI runs `npm run lint` at
   `error`. The remaining two are feature-line files and must be refactored, not
   downgraded:

   - `src/lib/storage.ts:129` — `saveSettings` is 62 lines (max 50)
   - `src/popup/app.ts:178` — `populateForm` has complexity **33** (max 15)

   `populateForm` is the substantial one: complexity 33 against a limit of 15 is
   not a near-miss, and the feature line's per-platform auto-sync toggles and
   companion settings are part of why. Re-loosening the ratchet would discard an
   upstream invariant.
2. **knip dead-code fitness function** (#475, ADR-037, `knip.jsonc`). The feature
   line adds many exports and has never been checked against it. Expect findings
   around dependency-injection seams exported only for tests.

## 8. Verification

In order, each gating the next:

1. `npm ci` (mandatory — the CRXJS resolution changes).
2. `nix run .#lint` — at `error` severity, plus `lint-platforms`.
3. `npx knip` — upstream's fitness function.
4. `nix run .#test` — 1446 local + upstream's additions.
5. `nix run .#build` — TypeScript check + production build.
6. **Load the built extension and sync one real conversation** end-to-end to
   Obsidian. The suite cannot see selector rot (`test/fixtures/dom-helpers.ts`
   builds the DOM the tests assert against), so a green suite is not evidence
   that extraction works.
7. Confirm `git merge-base --is-ancestor origin/main HEAD`.

**Known flake:** a cold `npm ci` run has produced 1 failed / 1445 passed with
`environment` at 113s against ~62s green, green on immediate re-run. Do not read
a single red as a merge regression — but capture *which* test fails rather than
re-running past it.

**Never rebuild after asking for an extension reload.** Vite emits
content-hashed filenames and deletes the old ones; the loaded extension then
404s and presents exactly as uninstalled.

## 9. Peer coordination

A concurrent session owns the extension-side repair worker (plan Tasks 8-10). It
is building Tasks 8, 9 and 10a as new modules in local-only territory
(`src/content/archive/`, `companion-client.ts`, a new `repairLoop.ts`) and has
**deferred** Task 10b — the four-line hook in `bootstrap.ts`'s `initialize()` —
until this merge lands. `bootstrap.ts` is the single hook point and the cheapest
piece to replay.

Obligations this spec accepts:

- Send the peer the `bootstrap.ts` resolution before merging it.
- Do not change tier semantics in `blockAlignment.js`, `normalizeForIdentity`, or
  tier ordering without telling the peer first.
- Take the `live_hash` census before enabling `claude` auto-sync (already done:
  0 / 4,812, snapshot preserved), and exercise a non-canary conversation before
  the canary.

## 10. Risks

| risk | mitigation |
|---|---|
| Resolution silently drops a feature-line behaviour | `preserve/` branch + tag are pushed; every "upstream wholesale" file is one this fork barely touched |
| Upstream's ChatGPT model is wrong and ours was right | Verification step 6 syncs a real ChatGPT conversation; upstream's reading is backed by `docs/investigation/chatgpt-dom-2026-09.md` and ours is not |
| A #468-class gap is imported into `sync-icon` | §5 makes the audit an explicit deliverable, not a hope |
| knip/lint findings balloon the change | Measured: 5 lint violations, 2 in scope. knip unmeasured — if findings are large, record them and gate with a `knip.jsonc` entry rather than expanding this merge |
| Peer conflict in `bootstrap.ts` | Peer deferred 10b; this spec commits to sending them the resolution first |

## 11. Deferred, recorded so it is not lost

- `data-chatgpt-selection-message-id` → `ChatSyncBlock.sourceId`. The server
  already accepts and persists it, and it is outside `buildManifest`'s hash, so
  it is purely additive and cannot churn identity. Re-derive against upstream's
  selector module. Check Claude's DOM for an equivalent id.
- Exercise the re-baseline path in production: `needsFullContent` → re-baseline →
  `live_hash`, still 0 / 4,812. All canary-era constraints are lifted.
- `#__next` is dead on every platform declaring it, lives only in
  `PLATFORM_ROOT_SELECTORS`, and is validated by nothing.
- Five selector groups have no fallback: gemini `DEEP_RESEARCH.panel`, perplexity
  `markdownContent`/`deepResearchCard`/`citationSpacer`, notebooklm
  `markdownContent`.
- e2e is unseeded here — no `auth/state.json`, no `.env.local`, empty
  `baselines/` — so the only rot detector available needs manual logins first.
- Relocate the root-level findings docs under `docs/` per project convention.
- Isolate the cold-start test flake.
