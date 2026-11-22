# Skill review

Pi Hub can periodically review completed conversations and propose reusable skills. This is a Hub-native feature, not a separately installed plugin. It does not start a second web server.

## Start

1. Open **Settings → Skills → Skill review** for the project.
2. Select a **Review model** and **Review reasoning level**. These do not change ordinary chat defaults. Only reasoning levels supported by that model are offered.
3. Enable **Automatic review for this project** and save. This is consent to send bounded conversation/tool excerpts to the selected model and incur usage charges.
4. Continue working. Only new completed, successful ordinary Hub turns are collected. Existing history and CLI sessions are not scanned automatically. Aborted turns, side chats and subagent sessions are excluded.
5. Open Skill review to inspect the queued count and waiting reason, or choose **Review now** for already queued evidence.
6. Expand a batch, check its source evidence and candidate comparison, then approve or reject each candidate. No candidate is applied automatically.

The server checks every ten minutes. By default automatic review waits at least six hours between attempts, and for five completed turns or a 24-hour oldest-evidence deadline. These thresholds are configurable. Busy projects wait. Closing the browser does not stop the server scheduler. Stopping Hub does; restarting checks durable state. A failed or interrupted batch retains evidence and needs an explicit manual retry, rather than automatically billing the same batch again.

Changing the review model/reasoning affects the next batch. Running batches retain the configuration they started with. There is no silent fallback if the model is unavailable. Turning automatic review off stops new collection and future dispatch, and durably cancels active automatic batches (another server process observes this before its next model turn or on its one-second ownership check). Re-enabling does not revive cancelled work; retained evidence can still be reviewed manually.

## Schedule, budgets and historical selection

**Schedule, budget & retention** accepts these per-project integers:

| Setting | Default | Allowed |
| --- | ---: | ---: |
| Minimum interval (hours) | 6 | 1–168 |
| Minimum completed turns | 5 | 1–100 |
| Maximum wait (hours) | 24 | 1–720 |
| Daily review batches | 4 | 1–100 |
| Daily tokens | 500,000 | 1,000–10,000,000 |
| Batch timeout (minutes) | 10 | 1–30 |
| Finished-record retention (days) | 30 | 1–365 |

Daily budgets use UTC and include manual batches and retries. One batch may make several model requests, within its turn/tool limits. The service reserves up to 100,000 tokens (or the remaining daily budget) before starting; it replaces the reservation with observed usage on a completed response/validation path. Cancelled, timed-out, interrupted or provider-failed requests keep at least the reservation because additional provider usage may be unknown. Reservations survive restart and archival. The token ceiling is **not an exact billing cap**: it is checked between requests, and a single response can exceed the remaining allowance. A batch crossing midnight belongs to its start day.

**Select a conversation to review** explicitly queues 1-based user-turn ranges (at most 100 turns) from a chosen ordinary session's **current branch**. It works with automatic review off. Only successful completed turns are eligible; side/subagent sessions, inaccessible sources, and files over 32 MiB are refused. Selection reads that session, not every historical transcript. The selected excerpts remain manual-only until **Review now**, even if automation is enabled. Already consumed or skipped evidence is not queued again.

## Tasks, diagnostics and retention

- **Cancel review** persists a cancellation request, stops the reviewer, and retains evidence. Late responses cannot commit candidates. It cannot retract a request already sent to a provider.
- **Retry this batch** selects only that batch's retained evidence and uses the currently saved reviewer settings. **Review now** handles fresh evidence, not failed batches. An archived failure can still be retried explicitly from **Pending evidence**.
- **Skip this evidence** removes it from the queue and records its identity so normal collection does not re-add it. Cancel a running batch before skipping its input.
- Batch history shows preparation/review/validation phase, safe failure category, available token/cost totals, staged evidence size, truncation/coverage, supplemental windows and duplicate suppression. No provider exception text or credentials are exposed as diagnostics. Usage may be partial on failure.
- Visible panels refresh every three seconds while running and ten seconds otherwise, and on focus/visibility return. Hidden panels stop polling. Updates preserve unsaved settings and include skill locks from other windows.
- Finished records are automatically archived after the retention period; **Archive expired records** runs the same cleanup immediately, and **Archive record** handles an individual eligible record. Pending candidates, active writes and applied rollback backups cannot be archived.
- Archives are private, atomic files under `<agentDir>/skill-evolution/archive/<project-hash>/<run-hash>.json`. Archival removes records from active state, **not** from disk; there is no archive restore/delete UI. Failed-evidence quarantine, daily accounting and content fingerprints remain in active state. No official skill file is cleaned up. After backing up state, an administrator may delete unneeded archive files while Hub is stopped.

## Skill locks

Each skill's detail has a **Lock skill** switch, separate from whether the skill is visible to the chat model.

- External installations and unknown sources default to locked.
- Known local skills default to unlocked.
- Users can unlock every discovered skill, including package, global and custom-path skills.
- A locked skill can still be read and used. Review cannot modify it.
- Bulk lock/unlock covers the skills currently listed, not future installs.
- Restore default removes that skill's override. Normal upstream version changes retain an explicit unlock; a changed source is evaluated again.
- Upstream package updates can overwrite local improvements to installed skills.

These locks protect **this review service**, not the operating system, ordinary chat coding tools, pi CLI, your editor, or a manual upstream package update.

## Safety and limitations

Review runs in an independent in-memory pi Session, with no normal project extensions, MCP, shell or write tools. Its tools are `read_skill` and `read_evidence`: they read only snapshotted catalog content or bounded, redacted supplementary evidence windows by ID, never arbitrary paths or live historical files. The reviewer cannot unlock skills or write official files.

The first release proposes changes to `SKILL.md` only. Supporting files are preserved; no generated scripts run, and there is no merge, automatic deletion or Git commit. New skills go to the project's `.pi/skills/<name>/SKILL.md`. Reload resources or start a new ordinary session to discover them normally.

Approval rechecks discovery, lock state, provenance, canonical path and original contents. It refuses stale candidates rather than overwriting later edits. Before/after backups and write intent are persisted before mutation. Rollback similarly refuses later edits and respects locks. For a newly created skill, rollback removes only its `SKILL.md`, never other files someone added beside it.

Evidence ranking favors corrections, failure/validation signals and repeated normalized requests, while always including the oldest eligible item to avoid starvation. These are heuristics, not proof of success. Long turns retain the request, outcome and bounded supplementary windows; omitted material remains unavailable. Fingerprints ignore frontmatter names, outer blank lines and line endings, but preserve case and internal whitespace so command/indentation fixes are not lost. They suppress duplicate bodies of installed, pending and rejected rules; pending targets also cannot acquire another candidate. Recent proposal hints discourage semantic repeats, but paraphrase detection is not guaranteed. Identity and rejection indexes retain their latest 10,000 entries.

Common credential patterns (including private keys, JWTs, credential URLs and common token/password forms) are redacted from evidence and skill reads; possible credentials in candidate content/reasons/summaries reject the batch. This is **not complete secret detection**. Inspect candidate content before approving. Failed batches may have incurred provider charges even when no usage total could be obtained.

## Storage and recovery

Private state is `<agentDir>/skill-evolution/state.json` (normally `~/.pi/agent/skill-evolution/state.json`), written atomically with mode 0600. It contains review configuration, skill lock overrides, bounded evidence, candidates, original contents and task states. Do not publish or commit it. Reading settings does not create it.

A cross-process reviewer lease permits one batch across this agent directory. A separate mutation lease serializes locks and approvals. Interrupted review claims become `interrupted` without calling a model. Interrupted file decisions reconcile by before/after bytes on the next decision; foreign changes require manual resolution. Malformed state (including symlinked or dangling state files) fails closed for review writes: restore a known-good backup instead of deleting protection records casually. Ordinary skill discovery remains available with unavailable/locked protection indicators. Historical reads use one nonblocking bounded regular-file read and reject malformed lines, cyclic/broken parent graphs, duplicate IDs and mismatched project headers without rewriting the source. Each model turn rechecks the durable claim and project trust; completion and actual budget settlement commit atomically.

Bounds: 200 pending turns/project, 100 retained batches/project, 16 MiB total state, 500 catalog skills, 64 KiB per SKILL.md. Batches take at most 12 evidence items / 80 KiB evidence, a 160 KiB initial prompt, 20 combined snapshot reads / 128 KiB returned text, 24 agent turns, three candidates and the configured timeout. Reaching storage bounds refuses further additions rather than silently deleting pending candidates or rollback backups. Older version-1 state remains readable: omitted policy/accounting fields use conservative defaults.

## Verification

```sh
node_modules/.bin/tsc --noEmit
npm run lint
node --experimental-strip-types --test lib/skill-evolution*.test.mjs lib/skill-review*.test.mjs components/SkillEvolutionPanel.test.mjs
node e2e/skill-review.mjs
node e2e/skill-review-workflow.mjs
```

The tests use temporary directories and faux providers, not real skills or paid model calls. The layout smoke renders production components offline. The workflow test bundles the real React controls and starts an isolated HTTP fixture using the production auth proxy, login handler, review/protection routes, state service and SDK reviewer. It covers login, configuration, collection, detached review, comparison, cross-window locks, approval, rollback, archive, cancel/retry and abrupt process restart, plus 1280/390/320px layouts. Automatic-disable cancellation, timeout, daily limits, source branches and bounded retrieval have service/SDK tests. This does not start Next dev/build or test the full AppShell/Next routing graph. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point at an existing Chromium installation.
