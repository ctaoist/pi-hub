# 0008 — Hub-native batch skill review

## Decision

Skill review is an opt-in Pi Hub service, not a pi plugin. There is no package installation, extension dispatch hook, separate HTTP listener, or plugin UI framework. This is an explicit, narrow downstream exception to CONTRIBUTING's restrictions on background scheduling and Hub-only configuration.

Hermes (`../hermes-agent`, inspected at 88a1c1f4) informs the independent review context and procedure-first, evidence-based skill guidance. pi-skill-evolve (c3312f4) informs candidate staging, approval, exclusion and recovery. Neither adjacent repository is a runtime dependency; their code is not vendored.

## Ownership

- A settled ordinary Hub session records bounded incremental evidence only while its project has opted in. It does not start a model call. Aborted runs and subagent/side sessions are excluded.
- Review model and reasoning strength are separately configurable per project, independent of ordinary chat defaults. Each batch captures both; unavailable models and unsupported strengths fail rather than silently falling back.
- A server timer checks local state every ten minutes. A project's configurable defaults are six hours between automatic reviews and five completed turns, with a 24-hour small-batch fallback. Active projects wait. Manual review bypasses those scheduling thresholds, not trust, exclusion, daily budgets or write protection. Explicit session/range selection is manual-only; it is not consent to scan or automatically transmit historical conversations.
- One independent in-memory SDK Session runs per batch. No normal extension, MCP server, project context loader, shell or filesystem write tool is attached. Evidence is data, never instructions. Candidates are returned as structured data and require user approval.
- The reviewer is disposed after completion or timeout. Its history is not a normal chat and cannot recursively enter the evidence queue.
- The first implementation changes SKILL.md only. Supporting files are left intact; directory-wide mutation is not exposed. No automatic merges, deletions, Git commits or model-driven approval.

## Protection and persistence

Hub-private state lives under the agent directory's `skill-evolution/`, not in third-party skills or installation lockfiles. Reads do not create this directory. External and unknown-source skills default to locked; known local skills default to unlocked. Every discovered skill can be explicitly unlocked by the user. Canonical file identity prevents symlink aliases from bypassing protection. Overrides survive content/version updates and are invalidated by source replacement.

Lock changes and approval/rollback serialize through the same cross-process lease. Approval rechecks discovery, lock state, canonical destination and content hash. A write-ahead record holds both versions; interrupted decisions are reconciled from their hashes without repeating model calls. New skill creation never overwrites an existing path. Rollback refuses later edits. Locks protect this service, not arbitrary CLI tools, shell commands or editors.

Task claims are durable. An interrupted review is reported as interrupted rather than silently billed again; its evidence remains available for explicit retry. Completed/no-change batches consume only their snapshotted evidence, never evidence arriving during review. Hub shutdown stops scheduling and aborts its reviewer. With Hub stopped, neither automatic review nor CLI integration runs. Durable cancellation prevents late output from committing. A shared UTC ledger reserves tokens before dispatch and survives archive/restart; unknown charges remain reserved, and between-request token checks are not an exact billing cap. Eligible ended records move to private archives after the configured retention age; pending candidates and applied rollback backups stay in active state. Failed-evidence quarantine and rejection fingerprints survive archival.

## UX and consent

Skills settings contain review opt-in, manual execution, pending evidence, candidate source/diff and approve/reject/rollback actions. Skill invocation and mutation lock are separate controls. Bulk unlock applies to the listed skills only; future external installs still default to locked. Enabling explicitly discloses that bounded chat/tool evidence goes to the selected review model and incurs token charges. Users must inspect candidates for sensitive or inaccurate guidance.
