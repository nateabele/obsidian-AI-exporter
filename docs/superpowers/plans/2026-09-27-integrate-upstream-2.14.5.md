# Upstream 2.14.5 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge upstream `origin/main` (release 2.14.5) into the local companion-sync feature line so the fork runs on a current base with upstream's platform repairs in force.

**Architecture:** One merge commit, upstream into our line (`git merge origin/main` on `feat/integrate-upstream-2.14.5`), so our history stays first-parent and each conflict is resolved once. The feature line is overwhelmingly additive — `companion-client.ts`, `sync-icon.ts`, `manifest.ts`, `src/content/archive/*` are absent upstream and merge clean. Real conflict is ~7 integration points of 27 touched files. Upstream's ChatGPT work, e2e harness and `watermark` mechanism are taken wholesale; our sync-status UI wins over upstream's badge.

**Tech Stack:** TypeScript, CRXJS + Vite 8, Vitest, Playwright (e2e), ESLint (ratcheted to `error`), knip, Nix task surface.

**Spec:** `docs/superpowers/specs/2026-09-27-integrate-upstream-2.14.5-design.md` (`3b8b662`)

## Global Constraints

- Branch is `feat/integrate-upstream-2.14.5`, already created off `main` (`86a925b`). Never commit to `main`.
- `@crxjs/vite-plugin` stays at **`^3.0.0`**. Upstream's `^2.0.0-beta.23` resolves to 2.3.0, which breaks on Vite 8 (`Unknown input options: platform`, never writes `vendor/vite-client.js`) and makes the extension load as if uninstalled.
- `vite: ^8.0.16`, `vitest: ^4.1.8`, `typescript: ^5.3.3`, `@playwright/test: ^1.58.2`, `knip: ^6.34.0` — take upstream's values.
- ESLint limits are **`error`**, not `warn`: `max-lines` 800, `max-lines-per-function` 50, `max-depth` 4, `complexity` 15. Never re-loosen them — that discards an upstream invariant.
- `package-lock.json` is **regenerated**, never hand-merged.
- `npm run lint` **is** `eslint src/ && node scripts/lint-platforms.mjs && knip` — one command, three gates. knip's config records that every test file counts as an entry, so **exports used only by tests are NOT reported** (deliberate, ADR-015). Never collapse a testable seam to appease knip: a finding means genuinely dead code, or an entry point CRXJS resolves from `src/manifest.json` that belongs in `knip.jsonc`'s `entry` array.
- Recovery references, both already pushed to `fork`: branch `preserve/companion-sync-2.2.0-base`, tag `pre-integration/2026-09-27`.
- `fork` = `git@github.com:nateabele/obsidian-AI-exporter.git` (ADMIN). `origin` = `sho7650/…` is **READ-only — never push there.**
- Do not change tier semantics in mail-api (`blockAlignment.js`, `normalizeForIdentity`, tier ordering) without telling the peer session first.
- **Never rebuild after asking for an extension reload** — Vite emits content-hashed filenames and deletes the old ones; the loaded extension then 404s and presents exactly as uninstalled.
- Known flake: a cold run has given 1 failed / 1445 passed with `environment` at 113s vs ~62s green. Do not read a single red as a regression — but capture *which* test failed rather than re-running past it.
- The `bootstrap.ts` resolution (ours wins; their `initialize()` hook applies almost unchanged) was sent to the peer session **before** Task 1 resolves that file, discharging the promise made in §9 of the spec. Task 7 Step 3 is the post-merge confirmation, not the first notice.

## Review Focus

1. **Platforms with no turn ordinal.** `getMessageWatermark()` returns `null` on Gemini, Perplexity and NotebookLM. The watcher must neither invalidate on every poll nor never invalidate. Upstream notes Gemini lazy-loads *older* messages, so a turn *count* is not a usable signal. → Task 5.
2. **First sync of a backfilled conversation.** 4,733 blocks have `producer='backfill'` and `live_hash` NULL, so the very first live sync routes through `needsFullContent` → re-baseline. This path has never run in production and the merge touches the manifest/sync seam. → Task 3.
3. **Settings written before either side's new keys existed.** Stored settings predating `maxNoteSizeMiB`, `scrollIdleTimeoutSec`, `scrollMaxTimeoutSec` (upstream) or `companionUrl`, `autoSyncPlatforms` (ours) must fall back to defaults, not surface `undefined` into the UI or a save. → Task 4.
4. **A ChatGPT answer containing a reasoning block.** Upstream's `markdownContent` repair is now the active primary where ours was deliberately dead, so `selectAnswerBlocks()` runs against reasoning structure for the first time here. The hidden "ChatGPT said:" marker text must never appear in output. → Task 6.
5. **Re-syncing the four ChatGPT conversations already in `chat.db`.** Their stored blocks were produced by *our* extractor. Upstream's model decomposes turns differently — one turn now holds both the prompt and the answer — so the anchor ordering and `msg_hash` values a fresh extraction produces may not line up with what is stored. The failure mode is duplicate blocks or a permanent `needsFullContent` loop on those conversations, not a crash. → Task 3 (test) and Task 6 (observed).

*(A zero-turn extraction painting `synced` was considered for this list and dropped: `SyncStateInput.blocked` already covers it and `test/content/index.test.ts` already asserts `'No messages found in conversation'`.)*

---

### Task 1: Take the merge and resolve it

**Files:**
- Modify (resolve): the 27 files that both sides touched — see the resolution table below
- Delete: `src/content/ui-badge.ts` (upstream-new; superseded by our `sync-icon.ts`)
- Test: existing suite is the harness; no new test file

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a merged tree on `feat/integrate-upstream-2.14.5` where `git merge-base --is-ancestor origin/main HEAD` is true; `src/content/message-watcher.ts` exports `startNewMessageWatcher`, `src/content/conversation-watcher.ts` exports `startConversationWatcher`, and `IConversationExtractor.getMessageWatermark(): number | null` exists (all inherited from upstream) for Task 5

- [ ] **Step 1: Confirm the starting state**

```bash
cd /Users/nate/Projects/Protos-n-Tools/obsidian-AI-exporter
git fetch origin
git branch --show-current          # expect: feat/integrate-upstream-2.14.5
git log -1 --format=%h             # expect: 3b8b662 (the spec commit)
git merge-base --is-ancestor origin/main HEAD && echo ALREADY || echo "diverged, as expected"
```

- [ ] **Step 2: Start the merge without committing**

```bash
git merge --no-commit --no-ff origin/main
```

Expected: conflicts. Capture the list before touching anything:

```bash
git diff --name-only --diff-filter=U | tee /tmp/merge-conflicts.txt
wc -l < /tmp/merge-conflicts.txt
```

- [ ] **Step 3: Resolve the "take upstream wholesale" group**

These are files this fork barely touched and upstream rewrote. Take theirs entirely:

```bash
git checkout --theirs src/content/extractors/chatgpt.ts
git checkout --theirs src/content/extractors/selectors/chatgpt.ts
git checkout --theirs e2e/selectors/classifier.ts
git checkout --theirs e2e/selectors/report-builder.ts
git checkout --theirs e2e/selectors/smoke-test.spec.ts
git checkout --theirs e2e/selectors/__tests__/classifier.test.ts
git checkout --theirs e2e/selectors/__tests__/report-builder.test.ts
git checkout --theirs e2e/selectors/__tests__/notify-policy.test.ts
git add src/content/extractors/chatgpt.ts src/content/extractors/selectors/chatgpt.ts e2e/selectors
```

Rationale, so a reviewer can check the judgement rather than the keystrokes: upstream changed `chatgpt.ts` by 447 lines against our 9, and the two repairs *disagree* about the DOM — upstream anchors on `div[data-turn-key]` and documents that `fallback-turn-N` is renumbered per mounted window, which is exactly the number our `[data-content-search-unit-key]` value embeds. Upstream's e2e `#509` adds `baselineState`, `missingGroups`, zero-match rejection and `ACCEPT_DEGRADED`, superseding our `1264140`.

- [ ] **Step 4: Resolve the "take local wholesale" group**

```bash
git checkout --ours src/content/ui.ts
git checkout --ours src/content/bootstrap.ts
git checkout --ours test/content/index.test.ts
git checkout --ours vite.config.ts
git add src/content/ui.ts src/content/bootstrap.ts test/content/index.test.ts vite.config.ts
```

Then delete upstream's superseded badge surface:

```bash
git rm -f src/content/ui-badge.ts
```

`ui.ts` and `bootstrap.ts` are where our sync-icon subsystem lives (825 and 215 lines changed against upstream's 165 and 124). Taking ours drops upstream's `injectSyncButton`, `ensureSyncAnchor`, `setButtonLoading` and `ui-badge.ts`. **Do not delete `message-watcher.ts` or `conversation-watcher.ts`** — those are the mechanism, they are upstream-new, they merge without conflict, and Task 5 wires them in.

- [ ] **Step 5: Resolve `src/lib/storage.ts` — upstream's file plus two keys**

```bash
git checkout --theirs src/lib/storage.ts
```

Then add our two keys to upstream's **module-scope** `PASS_THROUGH_KEYS`, immediately after `'maxNoteSizeMiB',`:

```typescript
  'maxNoteSizeMiB',
  'companionUrl',
  'autoSyncPlatforms',
] as const;
```

This is the whole change. Our `saveSettings` was 71 lines and tripped `max-lines-per-function` only because it declared `PASS_THROUGH_KEYS` *inside* the function; upstream hoisted it to module scope and their `saveSettings` is 46 lines. Taking theirs dissolves the lint violation instead of requiring a refactor. We also gain `maxNoteSizeMiB`, `scrollIdleTimeoutSec` and `scrollMaxTimeoutSec`.

```bash
git add src/lib/storage.ts
```

- [ ] **Step 6: Resolve the remaining upstream-dominant files, re-adding our additions**

For `src/lib/constants.ts`, `src/lib/messaging.ts`, `test/background/index.test.ts`: take upstream's version, then re-apply only the feature-line additions. Find what to re-add by diffing our side against the fork point:

```bash
MB=$(git merge-base HEAD origin/main)
for f in src/lib/constants.ts src/lib/messaging.ts test/background/index.test.ts; do
  echo "=== $f: what WE added since the fork point ==="
  git diff $MB:"$f" :2:"$f"
done
```

Take upstream's file and re-add those hunks by hand:

```bash
git checkout --theirs src/lib/constants.ts src/lib/messaging.ts test/background/index.test.ts
# then re-apply the companion/chatSync additions identified above
```

Expect: companion URL default and storage keys in `constants.ts`; the `chatSync`/`chatBackfill` message types in `messaging.ts`; the companion-routing cases in `test/background/index.test.ts`.

```bash
git add src/lib/constants.ts src/lib/messaging.ts test/background/index.test.ts
```

- [ ] **Step 7: Resolve the additive-union files**

`src/lib/types.ts`, `src/popup/app.ts`, `src/popup/index.html`, `src/background/validation.ts`, `src/background/service-worker.ts`, `src/manifest.json`, `src/_locales/en/messages.json`, `src/_locales/ja/messages.json`.

Both sides added different things; keep both sides of every conflict hunk, deleting only the conflict markers. Two specifics that must survive:

- `src/lib/types.ts` — upstream adds `getMessageWatermark(): number | null` to `IConversationExtractor` (~line 443). **This must survive**; Task 5 depends on it. Our additions are the companion/chatSync interfaces plus `companionUrl` and `autoSyncPlatforms` on the settings type.
- `src/popup/app.ts` — upstream's `populateForm` is a 15-line delegator to `populateOutputOptions`, `populateExtractionOptions`, `populateObsidianSettings`, `populateTemplateOptions`, `populateFrontmatterOptions`, `populateTimezone`, `populateScrollTimeouts`. Take that shape and add our companion settings as a **new sibling helper**, not as inline branches:

```typescript
function populateCompanionSettings(settings: ExtensionSettings): void {
  const companionUrl = document.getElementById('companionUrl') as HTMLInputElement | null;
  if (companionUrl) companionUrl.value = settings.companionUrl;
  for (const platform of PLATFORM_REGISTRY_KEYS) {
    const toggle = document.getElementById(`autoSync-${platform}`) as HTMLInputElement | null;
    if (toggle) toggle.checked = settings.autoSyncPlatforms.includes(platform);
  }
}
```

and call it from `populateForm` alongside the others. Our `populateForm` had complexity 33 against a limit of 15; following upstream's delegation pattern is what keeps it under.

```bash
git add src/lib/types.ts src/popup/app.ts src/popup/index.html src/background/validation.ts \
        src/background/service-worker.ts src/manifest.json src/_locales/en/messages.json src/_locales/ja/messages.json
```

- [ ] **Step 8: Resolve `package.json` — upstream's, keeping our CRXJS pin**

```bash
git checkout --theirs package.json
```

Then set the pin back:

```bash
npm pkg set devDependencies.@crxjs/vite-plugin='^3.0.0'
node -e "const p=require('./package.json');console.log('crxjs:',p.devDependencies['@crxjs/vite-plugin'],'vite:',p.devDependencies.vite)"
```

Expected: `crxjs: ^3.0.0 vite: ^8.0.16`

```bash
git add package.json
```

- [ ] **Step 9: Regenerate the lockfile rather than merging it**

```bash
git checkout --theirs package-lock.json
rm -rf node_modules
npm install --package-lock-only
node -e "const l=require('./package-lock.json');console.log(l.packages['node_modules/@crxjs/vite-plugin'].version)"
```

Expected: a 3.x version. If it prints 2.x, the pin did not take — fix Step 8 before continuing.

```bash
git add package-lock.json
```

- [ ] **Step 10: Confirm nothing is left unresolved, then typecheck**

```bash
git diff --name-only --diff-filter=U    # expect: empty
npx tsc --noEmit
```

Expected: no output from either. TypeScript errors here are almost always a Step 6 or 7 omission — a re-added hunk that referenced a symbol that did not come across, or a dropped `getMessageWatermark`.

- [ ] **Step 11: Commit the merge**

```bash
git commit --no-edit -m "$(cat <<'MSG'
merge: upstream 2.14.5 into the companion-sync feature line

Local main was an 11-week-old fork off release 2.2.0 (2026-07-07) while
upstream reached 2.14.5, 149 commits ahead and diverged. The handoff recorded
"extension main: release 2.2.0" -- a local fact that reads like a current one,
which is how a day went into repairing platform rot upstream had already
repaired.

Takes upstream's ChatGPT work wholesale. The two repairs disagreed about the
DOM and upstream is right: `fallback-turn-N` is renumbered per mounted window,
and ours keyed on a value containing exactly that number. Ours extracted four
turns correctly from one mounted window and was recorded as verified -- a fix
verified against the state it was measured in.

Keeps our sync-icon over upstream's status badge, but inherits the mechanism
behind it: message-watcher, conversation-watcher and getMessageWatermark() come
across and get wired into the icon separately.

Keeps @crxjs/vite-plugin at ^3.0.0. Upstream still ships ^2.0.0-beta.23 with
Vite 8, which resolves to 2.3.0 and never writes vendor/vite-client.js; its CI
runs lint/format/test/build, never the dev server, so upstream has not noticed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
git merge-base --is-ancestor origin/main HEAD && echo "on a current base"
```

---

### Task 2: Audit the resolution for lost feature-line behaviour

**Files:**
- Read only: the merged tree against `preserve/companion-sync-2.2.0-base`
- Create: `docs/superpowers/plans/2026-09-27-resolution-audit.md` (findings)

**Interfaces:**
- Consumes: the merge commit from Task 1
- Produces: a findings list; any real loss is fixed here before the suite runs

The risk this task exists to catch: Steps 3, 5, 6 and 8 all took upstream's version of a file, and each could have silently dropped a feature-line behaviour.

- [ ] **Step 1: List every symbol the feature line exported that no longer exists**

```bash
git diff preserve/companion-sync-2.2.0-base..HEAD --name-only -- src/ > /tmp/changed.txt
for f in $(git ls-tree -r --name-only preserve/companion-sync-2.2.0-base -- src/); do
  git show preserve/companion-sync-2.2.0-base:"$f" 2>/dev/null \
    | rg -o '^export (async )?function ([A-Za-z0-9_]+)' -r '$2' 2>/dev/null \
    | while read sym; do
        git grep -q "\b$sym\b" HEAD -- src/ || echo "GONE: $sym (was in $f)"
      done
done | sort -u
```

Expected `GONE` entries are only the deliberate drops: `injectSyncButton`, `ensureSyncAnchor`, `setButtonLoading`, `showSyncBadge`, `clearSyncBadge`. Anything else is a resolution bug — restore it.

- [ ] **Step 2: Confirm the companion settings survived end to end**

```bash
rg -n 'companionUrl' src/lib/storage.ts src/lib/types.ts src/lib/constants.ts src/popup/app.ts src/popup/index.html
rg -n 'autoSyncPlatforms' src/lib/storage.ts src/lib/types.ts src/popup/app.ts
```

Expected: `companionUrl` in all five, `autoSyncPlatforms` in all three. A miss in `popup/index.html` means the control exists in code with no markup to bind to.

- [ ] **Step 3: Confirm the chatSync message routing survived**

```bash
rg -n 'chatSync|chatBackfill' src/lib/messaging.ts src/background/service-worker.ts | head -20
```

Expected: the message type union entries and their service-worker handlers both present.

- [ ] **Step 4: Confirm the inherited watermark mechanism is intact**

```bash
test -f src/content/message-watcher.ts && test -f src/content/conversation-watcher.ts && echo "watchers present"
rg -n 'getMessageWatermark' src/lib/types.ts src/content/extractors/base.ts
test -f src/content/ui-badge.ts && echo "ERROR: badge should be deleted" || echo "badge correctly removed"
```

- [ ] **Step 5: Record findings and commit any fixes**

Write what was checked and what was found to `docs/superpowers/plans/2026-09-27-resolution-audit.md`. If Steps 1-4 surfaced real losses, fix them and commit:

```bash
git add -A && git commit -m "fix(merge): restore feature-line behaviour dropped in resolution"
```

If nothing was lost, commit the audit note alone so the check is on the record:

```bash
git add docs/superpowers/plans/2026-09-27-resolution-audit.md
git commit -m "docs: record the resolution audit for the 2.14.5 merge"
```

---

### Task 3: Restore the test suite to green

**Files:**
- Modify: whichever test files fail — expected concentration in `test/content/index.test.ts`, `test/background/index.test.ts`, `test/popup/index.test.ts`, `test/extractors/chatgpt*.test.ts`
- Delete: `test/extractors/chatgpt.test.ts` and `test/extractors/chatgpt-autoscroll.test.ts` if they assert the superseded selectors
- Test: the suite itself

**Interfaces:**
- Consumes: the audited merge from Task 2
- Produces: a green suite; `npm test` is the regression gate for Tasks 4-6

- [ ] **Step 1: Install cleanly, then get the real failure list**

```bash
npm ci
npx vitest run --reporter=verbose 2>&1 | tee /tmp/test-run-1.txt | tail -40
rg -n '✗|FAIL|×' /tmp/test-run-1.txt | head -40
```

Do not start fixing from a single run. Re-run once and compare, because of the known cold-start flake:

```bash
npx vitest run 2>&1 | tail -15
```

If a test fails in run 1 and passes in run 2, record its name in the commit message rather than "fixing" it.

- [ ] **Step 2: Delete the ChatGPT tests that assert the selectors we dropped**

Our ChatGPT tests were written against `[data-content-search-unit-key]` and the `:role` suffix. Upstream ships `test/extractors/chatgpt-2026-09.test.ts` against `div[data-turn-key]`. Keeping both means asserting two contradictory DOM models.

```bash
rg -l 'data-content-search-unit-key|fallback-turn' test/ | tee /tmp/stale-chatgpt-tests.txt
git rm $(cat /tmp/stale-chatgpt-tests.txt)
npx vitest run test/extractors 2>&1 | tail -10
```

- [ ] **Step 3: Write the failing test for Review Focus 5 — stored ChatGPT blocks vs the new turn model**

The four ChatGPT conversations in `chat.db` were anchored under our old model. Upstream's `div[data-turn-key]` model puts the prompt and answer in ONE turn. Pin that a fresh extraction still produces one block per message, in role order, so anchors and hashes stay comparable with what is stored.

Add to `test/extractors/chatgpt-2026-09.test.ts` (upstream's file, which already builds the new DOM):

```typescript
it('emits one block per message in role order, not one per turn', () => {
  // Two turns, each holding a prompt AND its answer -- the 2026-09 shape.
  document.body.innerHTML = buildPairTurns([
    { user: 'first question', assistant: 'first answer' },
    { user: 'second question', assistant: 'second answer' },
  ]);
  const messages = new ChatGPTExtractor().extractMessages();
  expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(messages.map(m => m.markdown)).toEqual([
    'first question', 'first answer', 'second question', 'second answer',
  ]);
});
```

Use whatever fixture builder upstream's file already imports — find it first rather than writing a new one:

```bash
rg -n 'import|function build' test/extractors/chatgpt-2026-09.test.ts | head -15
```

- [ ] **Step 4: Run it and confirm what it tells you**

```bash
npx vitest run test/extractors/chatgpt-2026-09.test.ts 2>&1 | tail -25
```

If it PASSES, upstream's extractor already flattens pair turns into per-message blocks and stored anchors remain comparable — record that and move on. If it FAILS, the merge has changed ChatGPT's block decomposition, which means those four conversations will mis-align on their next sync. **Do not change upstream's extractor to match our old model.** Record the finding, and treat re-aligning those four conversations as separate work (mail-api's repair path exists for exactly this); note it in the Task 7 handoff.

- [ ] **Step 5: Confirm the whole suite**

```bash
npx vitest run 2>&1 | tail -15
```

- [ ] **Step 6: Write the failing test for Review Focus 2 — first sync of a backfilled conversation**

In `test/content/index.test.ts`, assert the client honours a `needsFullContent` response by resending full content exactly once rather than looping:

```typescript
it('resends full content once when the server answers needsFullContent', async () => {
  const post = vi.fn()
    .mockResolvedValueOnce({ mode: 'needsFullContent', appended: 0 })
    .mockResolvedValueOnce({ mode: 'rebaselined', appended: 0 });
  await runAutoSync({ postSync: post, extraction: fixtureWithTurns(3) });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1][0].newBlocks).toHaveLength(3);
});
```

- [ ] **Step 7: Run it, implement if it fails, confirm green**

```bash
npx vitest run test/content/index.test.ts 2>&1 | tail -20
npx vitest run 2>&1 | tail -15
```

Expected final: all tests passing. Record the count.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: restore the suite against upstream 2.14.5

Drops the ChatGPT tests asserting the superseded selector model and pins two
behaviours the merge made newly reachable: a zero-turn extraction must paint
attention rather than synced, and a backfilled conversation's first sync must
resend full content exactly once."
```

---

### Task 4: Satisfy the lint ratchet, knip, and the settings-defaults gap

**Files:**
- Modify: whatever `eslint`/`knip` name; `src/lib/storage.ts` for defaults
- Test: `test/lib/storage.test.ts`

**Interfaces:**
- Consumes: green suite from Task 3
- Produces: `npm run lint` (which includes knip) and `npm test` all clean

- [ ] **Step 1: Run lint at error severity and capture the real list**

```bash
npm run lint 2>&1 | tail -40
```

That one command runs `eslint src/`, then `scripts/lint-platforms.mjs`, then `knip` — three gates, failing at the first. Run parts separately (`npm run lint:platforms`, `npm run lint:dead`) only to isolate a failure.

The two pre-merge violations should be gone: `saveSettings` because upstream hoisted `PASS_THROUGH_KEYS` to module scope, `populateForm` because Task 1 Step 7 followed upstream's delegation pattern. If either still trips, extract a named helper — never relax the rule.

- [ ] **Step 2: Fix each violation, re-running after each**

```bash
npm run lint 2>&1 | tail -20
```

Expected: clean exit.

- [ ] **Step 3: Read what knip reported (it already ran inside `npm run lint`)**

```bash
npm run lint:dead 2>&1 | tail -40
```

**Do NOT restructure modules to avoid knip findings.** `knip.jsonc` records that the Vitest and Playwright plugins are auto-detected, every test file counts as an entry, and therefore **exports used only by tests are NOT reported** — deliberately, per ADR-015. An exported dependency-injection seam with a test importing it is both reachable and used.

So a finding here is either genuinely dead code (delete it) or a real entry point knip cannot see because CRXJS resolves it from `src/manifest.json` (add it to `knip.jsonc`'s `entry` array, following that file's existing comment). The four listed entries — `service-worker.ts`, `content/index.ts`, `popup/index.ts`, `offscreen/offscreen.ts` — all exist on both sides.

- [ ] **Step 4: Write the failing test for Review Focus 3 — settings predating the new keys**

In `test/lib/storage.test.ts`:

```typescript
it('falls back to defaults for keys absent from stored settings', async () => {
  chrome.storage.sync.get = vi.fn().mockResolvedValue({
    settings: { obsidianUrl: 'http://127.0.0.1:27123', vaultPath: 'AI/{platform}' },
  });
  const s = await getSettings();
  expect(s.companionUrl).toBe(DEFAULT_COMPANION_URL);
  expect(s.autoSyncPlatforms).toEqual([]);
  expect(s.maxNoteSizeMiB).toBe(DEFAULT_MAX_NOTE_SIZE_MIB);
  expect(s.scrollIdleTimeoutSec).toBe(DEFAULT_SCROLL_IDLE_TIMEOUT_SEC);
});
```

- [ ] **Step 5: Run it, implement the minimal fix, confirm**

```bash
npx vitest run test/lib/storage.test.ts 2>&1 | tail -20
```

If it fails, the merged `getSettings()` is missing defaults for one side's keys. Add them to the defaults object only.

- [ ] **Step 6: Full gate, then commit**

```bash
npm run lint && npx vitest run 2>&1 | tail -10
git add -A
git commit -m "fix: satisfy upstream's lint ratchet and knip, and default the merged settings keys

Upstream promoted max-lines/complexity from warn to error (#477) and added knip
as a dead-code fitness function (#475); neither had ever been applied to the
feature line. Also pins that settings written before either side's new keys
existed fall back to defaults rather than surfacing undefined."
```

---

### Task 5: Wire the inherited watermark into `sync-icon` (the #468 guarantee)

**Files:**
- Modify: `src/content/sync-icon.ts`, `src/content/bootstrap.ts`
- Modify: `src/_locales/en/messages.json` and `src/_locales/ja/messages.json` — add `syncIcon_conversationGrewSinceSync` to **both**, or `lint:platforms` and the i18n checks will fail
- Test: `test/content/sync-icon-watermark.test.ts` (create)

**Interfaces:**
- Consumes: `startNewMessageWatcher` from `src/content/message-watcher.ts`, `startConversationWatcher` from `src/content/conversation-watcher.ts`, `getMessageWatermark(): number | null` on the extractor — all inherited in Task 1
- Produces: `sync-icon` state is invalidated when the conversation grows past what the sync covered

This is the one place the merge could otherwise import a real bug. Upstream's #465/#468: the badge shipped as a point-in-time record, so adding messages afterwards left the checkmark in place and *a partial sync was indistinguishable from a complete one*. Our `sync-icon` has `8cc684e` and `d5bf5dd`, but both key on conversation **identity changing** — neither fires when a new message arrives **within** the same conversation. Upstream's fix is a conversation-wide turn ordinal that is never renumbered (`data-index` on Claude, `conversation-turn-N` on ChatGPT); a value strictly greater than the one the sync covered proves a new turn, while scrolling can only surface ordinals at or below it.

- [ ] **Step 1: Write the failing test**

Note the real interfaces, which differ from what you might assume: there is **no** `getIconState` — state lives in `button.dataset.state` — and `SyncStateDetail` is `{ suggestionCount?, error?, notePath?, blocked? }`, with **no** watermark field. Read `src/content/sync-icon.ts:280` before writing.

Create `test/content/sync-icon-watermark.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { injectSyncIcon, paintFor, setIconContext, attachWatermarkWatcher } from '../../src/content/sync-icon';

const state = (): string | undefined =>
  document.getElementById('g2o-sync-icon')?.dataset.state;

describe('sync-icon watermark invalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    injectSyncIcon({} as never);
    setIconContext('/c/abc');
  });
  afterEach(() => vi.useRealTimers());

  it('leaves synced in place while the watermark does not advance', () => {
    paintFor('/c/abc', 'synced');
    const stop = attachWatermarkWatcher('/c/abc', 12, () => 12);
    vi.advanceTimersByTime(5000);
    expect(state()).toBe('synced');
    stop();
  });

  it('drops synced when a strictly greater watermark appears', () => {
    paintFor('/c/abc', 'synced');
    let current = 12;
    const stop = attachWatermarkWatcher('/c/abc', 12, () => current);
    current = 13;
    vi.advanceTimersByTime(5000);
    expect(state()).toBe('attention');
    stop();
  });

  it('never invalidates on platforms with no ordinal', () => {
    paintFor('/c/abc', 'synced');
    const stop = attachWatermarkWatcher('/c/abc', null, () => null);
    vi.advanceTimersByTime(5000);
    expect(state()).toBe('synced');
    stop();
  });
});
```

`injectSyncIcon` takes a handlers object; pass `{} as never` since none of these cases clicks anything. If the real signature rejects that, read it and pass the minimum it requires.

The third case is Review Focus 1: Gemini, Perplexity and NotebookLM return `null`, and a null watermark must mean "no signal", never "invalidate".

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run test/content/sync-icon-watermark.test.ts 2>&1 | tail -20
```

Expected: FAIL — `attachWatermarkWatcher` and `getIconState` do not exist.

- [ ] **Step 3: Implement `attachWatermarkWatcher` in `sync-icon.ts`**

Delegate to the inherited watcher; do not write a new polling loop:

```typescript
import { startNewMessageWatcher } from './message-watcher';

/**
 * Invalidate this conversation's painted state once the page grows past the
 * turn the sync covered. A null watermark means the platform exposes no
 * conversation-wide ordinal (Gemini lazy-loads OLDER turns, so a count is not
 * a usable signal) -- no signal, so no invalidation.
 */
export function attachWatermarkWatcher(
  href: string,
  syncedWatermark: number | null,
  getWatermark: () => number | null
): () => void {
  if (syncedWatermark === null) return () => {};
  return startNewMessageWatcher({
    syncedWatermark,
    getWatermark,
    onNewMessage: () =>
      paintFor(href, 'attention', {
        blocked: getMessage('syncIcon_conversationGrewSinceSync'),
      }),
  });
}
```

- [ ] **Step 4: Run to green**

```bash
npx vitest run test/content/sync-icon-watermark.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Wire it into the sync path in `bootstrap.ts`**

Call `attachWatermarkWatcher` where the icon is painted `synced`, passing the watermark **taken from the extraction result, never re-read from the DOM**. Upstream's #465 note explains why: the auto-scroll pass ends pinned at the top of the conversation, where the newest turn is unmounted and its ordinal is gone. Stop the previous watcher before starting a new one.

- [ ] **Step 6: Full suite, then commit**

```bash
npx vitest run 2>&1 | tail -10
npm run lint
git add -A
git commit -m "fix(sync-icon): drop synced when the conversation grows past the sync

Ports upstream's #465/#468 guarantee onto our icon using the mechanism the
merge inherited. Our 8cc684e and d5bf5dd both key on conversation identity
changing, so neither fired when a new message arrived within the same
conversation -- a partial sync was indistinguishable from a complete one.
Platforms without a conversation-wide ordinal return null and are left alone."
```

---

### Task 6: Build, load, and verify end to end

**Files:**
- No source changes expected; fixes land here if verification fails

**Interfaces:**
- Consumes: everything above
- Produces: evidence the merged extension actually extracts and syncs

The suite cannot see selector rot — `test/fixtures/dom-helpers.ts` builds the DOM the tests assert against — so a green suite is **not** evidence that extraction works. This task is what validates taking upstream's ChatGPT model.

- [ ] **Step 1: Build**

```bash
npm run build 2>&1 | tail -20
ls -la dist/ | head
test -f dist/manifest.json && echo "manifest emitted"
```

- [ ] **Step 2: Confirm the Obsidian endpoint before blaming the extension**

```bash
lsof -nP -iTCP:27123 -iTCP:27124 -sTCP:LISTEN
```

Nothing on 27123 means the plugin is HTTPS-only and the vault answers on `https://127.0.0.1:27124` with a self-signed certificate. Do not "fix" `DEFAULT_OBSIDIAN_URL` to match a local setup.

- [ ] **Step 3: Load the built extension**

Ask the user to load `dist/` at `chrome://extensions` → Load unpacked. **Do not rebuild after asking** — Vite emits content-hashed filenames and deletes the old ones, so a rebuild makes the loaded extension 404 and present exactly as uninstalled.

- [ ] **Step 4: Verify a real ChatGPT conversation extracts**

Open a ChatGPT conversation with more turns than fit one screen, and one containing a reasoning block if available (Review Focus 4). Sync it. Confirm: turn count matches the page; user and assistant text are both present and correctly attributed; **the hidden "ChatGPT said:" marker text does not appear anywhere in the note**; a long conversation yields all turns, not just the rendered window.

- [ ] **Step 5: Verify a real Claude conversation, and the watermark guarantee**

Sync a Claude conversation, confirm the icon reads `synced`, then send a new message in that same conversation and confirm the icon **leaves** `synced` without navigating away. That is Task 5's guarantee observed in the product.

- [ ] **Step 6: Record the evidence**

Append what was verified — platform, turn counts, note paths, icon transitions — to `docs/superpowers/plans/2026-09-27-resolution-audit.md`, then commit.

```bash
git add docs/superpowers/plans/2026-09-27-resolution-audit.md
git commit -m "docs: record end-to-end verification of the 2.14.5 merge"
```

---

### Task 7: Publish to the fork and hand off

**Files:**
- No source changes

**Interfaces:**
- Consumes: verified branch
- Produces: the work on `fork`, and the peer unblocked

- [ ] **Step 1: Final gate**

```bash
npm run lint && npm run format:check && npx vitest run 2>&1 | tail -5 && npm run build 2>&1 | tail -5
git merge-base --is-ancestor origin/main HEAD && echo "on a current base"
git status --short
```

- [ ] **Step 2: Push the branch to the fork — never to `origin`**

```bash
git push fork feat/integrate-upstream-2.14.5
```

- [ ] **Step 3: Tell the peer session the `bootstrap.ts` resolution is settled**

Send, via SendMessage to `backfill`: that the merge landed, that `bootstrap.ts` resolved to **our** wiring (so their `initialize()` hook applies almost unchanged), that `message-watcher.ts` / `conversation-watcher.ts` / `getMessageWatermark()` are now available to them, that `ui-badge.ts` is gone, and the branch name to rebase Task 10b onto. This was promised before merging that file.

- [ ] **Step 4: Report what is still open**

State plainly: the ChatGPT export has still never queued (1,455 conversations blocked on a human step — Export → Confirm → code → **Confirm again**, link expires in 24h); `live_hash` is still 0 / 4,812 so the re-baseline path is still unexercised in production; e2e remains unseeded on this machine.
