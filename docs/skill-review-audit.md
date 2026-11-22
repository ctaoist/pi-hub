# Skill review audit

Scope: the uncommitted Hub-native skill-review implementation, API/UI integration and tests. No real skills, paid providers, deployed authentication settings or Next build output were changed.

## Review rounds

### Round 1 — input, trust and failure isolation

| Finding | Evidence | Fix / regression coverage |
| --- | --- | --- |
| High: disabling automatic review was not durable across processes | Configuration only changed `enabled`; the owning process could miss an off/on transition between monitor ticks. The new audit test failed with `cancelRequested === undefined`. | Persist cancellation on automatic claims, preserve explicit manual claims, never clear cancellation on re-enable. `skill-review-audit.test.mjs`. |
| High: historical reads could block or exceed their advertised bound | A `stat().size` check preceded SDK `open()`, which reread the path without a bound; SDK could also initialize an empty file. | Single nonblocking bounded regular-file read, then in-memory SDK projection; FIFO, oversize, empty and malformed-source tests. |
| High: malformed source parent graphs could hang traversal | SDK `getBranch()` follows parent IDs without a cycle guard. Constructing an in-memory manager with the authorized cwd also does not authenticate the file header's cwd. | Validate the original header, duplicate IDs and earlier-parent graph before SDK traversal; cycle and wrong-project tests. |
| Medium: POST size checks occurred after full buffering | Both routes used `request.text()` before measuring. The red test read **101 chunks** despite a 16 KiB limit. | Shared streamed request reader; review and protection route tests assert early cancellation and 413. |
| Medium: broken optional state broke ordinary Skills listing | `annotateSkillProtection()` propagated state parse errors to the common skill service. Red test threw instead of returning skills. | Discovery degrades to locked/unavailable annotations without writing fallback state; review mutation remains strict. |
| Medium: dangling state symlink reset protection implicitly | The regular-file helper treated a dangling link as missing state. Red test expected refusal but got empty state. | Refuse nonregular/symlink state files, retaining fail-closed behavior. |
| High: consent/trust could change between dispatch and later model turns | Only initial checks, final validation and a periodic monitor protected the reviewer. | Recheck durable claim, cancellation and trust before each model turn; SDK faux-provider test proves a revoked policy prevents a second request. Preparation/authorization waits are inside the cancellation race. |

Initial reproducible red-test log: `/tmp/review-audit-red.log` (four failures before fixes).

### Round 2 — recovery, budgets and semantic regressions

| Finding | Evidence | Fix / regression coverage |
| --- | --- | --- |
| Medium: terminal state and billing had separate crash windows | Terminal run status was saved before the `finally` transaction settled the reservation. A response exceeding the reservation could leave a completed run with understated accounting after a crash. | Commit terminal status and observed charge together. Integration test checks observed terminal snapshots with usage exceeding the reservation. Use the same timestamp for UTC day selection and run creation. |
| Medium: deduplication could erase meaningful code changes | Lowercasing and collapsing all whitespace made case-sensitive commands and different Python indentation hash identically. | Preserve case and internal whitespace, including first-line indentation; normalize only line endings and surrounding blank lines. Regression assertions cover each distinction. |
| Medium: manual dispatch could precede orphan recovery | Only the timer recovered abandoned `running` records, so manual requests could encounter stale claims until the next check. | Every successful reviewer-lease owner recovers orphan claims first, with a checkpoint even when dispatch is subsequently refused. Integration test retries the recovered record. |

Also checked: lock changes versus approval, stale file conflicts, exclusive new-file publication, rollback recovery, retention protecting backups, failed-evidence quarantine, explicit historical selection, token limits between provider requests, cancellation/timeout late results, branch correctness and dirty-draft refresh.

### Final pass

Re-read changed source and integration points, including untracked new modules (ordinary `git diff` omits those), and ran `git diff --check`. No additional medium/high issue was identified in this pass within the tested threat model.

## Verification

- TypeScript: pass (`/tmp/review-audit-final-tsc.log`).
- Full-repository ESLint: pass (`/tmp/review-audit-final-lint.log`).
- Targeted regression suite: **68 passed** (`/tmp/review-audit-final-targeted.log`).
- Full suite: **3731 passed, 2 failed, 3 skipped** (`/tmp/review-audit-final-full.log`).
- An untouched `git archive HEAD` temporary checkout reproduced the same two failures: **3691 passed, 2 failed, 3 skipped** (`/tmp/review-audit-baseline-full.log`). Failures are the npm registry probe in `plugin-updates.test.mjs` and the root/read-only-directory assertion in `rotate-preview-secrets.test.mjs`.
- Authenticated isolated browser workflow passed with production controls/proxy/routes and a faux provider, including close-browser continuation, cross-window locks, dirty-draft preservation, approve/rollback, cancellation/retry and abrupt restart. Layouts: 1280/390/320px (`/tmp/review-audit-final-workflow.log`).

## Remaining risks / not verified

1. The browser fixture does not exercise full AppShell/Next/Turbopack routing or the deployed authenticated instance. No real-provider cancellation, streaming usage or billing accuracy was tested.
2. Windows/macOS native filesystem semantics, hard-link support, network filesystems and old Safari were not run. Linux FIFO/link tests and Chromium are the tested platforms.
3. Provider cancellation is best effort. An already transmitted request may continue and incur charges; unknown usage keeps a reservation. Token checks are between requests, not a hard invoice ceiling.
4. The host filesystem and local user are trusted. SDK queues and review leases coordinate cooperating writers, but cannot provide filesystem-wide compare-and-swap against arbitrary external editors, path swaps, malicious same-user processes or power-loss durability on every filesystem.
5. Credential detection, workflow scoring and semantic duplicate prevention remain heuristic. Content goes to a model only with opt-in/manual authorization, and every official skill change still requires approval.
6. Archives intentionally remain on disk; active state is bounded, but archive disk retention is an administrator responsibility. The latest 10,000 identity/fingerprint entries are retained, not an unbounded forever ledger of rejected content.
7. Full-suite verification is not green because of the two reproduced baseline failures above; they were not modified as part of this feature audit.
