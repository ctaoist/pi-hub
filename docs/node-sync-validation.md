# Node synchronization validation record

## Event-driven incremental WSS revision (v3)

Latest checks on Linux/Node v26.13.1:

- **87 focused tests passed**, including file-level deltas, omitted-body concurrent-edit refusal/retry, losing-version suppression, canonical fingerprints, atomic-save debounce, new/replaced/deleted directories, exclusions, symlink refusal, watcher cleanup and audit fallback.
- Three-process real-WSS E2E passed. Edits/deletions were required to converge within **8 seconds** (not a latency SLA); cross-node relay within 12 seconds. Captured pre-encryption frame metadata proved an unchanged `auth.json` body was not retransmitted, one save burst sent one changed file body, and quiet links started no application exchanges during the observation window.
- Existing TLS/auth/throttle, authority, reconnect, pause/resume/removal and filesystem recovery tests remain covered. A coordinator-level test exercises a concurrent authority edit, fresh-index retry and dirty-event retention without a feedback loop.
- Review reproduced a missing check for same-hash, omitted bodies with inconsistent size metadata. It now rejects the batch; the failure and fix are covered by `sync-delta.test.mjs`.
- An isolated production build and v3 encrypted registration/real API/Chromium smoke passed outside the active worktree before the final one-line same-hash size validation; that final check was covered by the subsequent focused/full suites and WSS E2E.
- TypeScript, ESLint and Diff checks passed.
- Full suite: **3,690 passed, 3 failed, 3 skipped** (3,696 total); the same three baselined environment failures below remain.

The full version index is still exchanged each round. Only file bodies are incremental; local correctness scans still rehash the allowed scope. Changed files are transferred whole, not binary blocks. A five-minute audit is the fallback for missed events or watcher limits. Native Windows/macOS watcher behavior, large-tree load and real deployment infrastructure remain unverified. This revision has not been deployed to the running service.

## Previous WSS revision (v2)

The transport has since been replaced with client-initiated WSS; the historical HTTP results below are retained as evidence for the unchanged filesystem/merge engine, not as validation of the new transport.

Latest WSS checks (Linux, Node v26.13.1):

- **78 focused tests passed** (sync/API/channel/config/recovery, Settings/i18n/navigation, launcher process recognition and package pinning).
- `e2e/sync-wss.mjs` passed with three isolated processes and real TLS: no reverse URL/password, CA/auth/Host/Origin/throttle, encrypted frame inspection, bidirectional snapshots, relay/authority, reconnect/offline catch-up, deletion, pause/resume and refusal to restore removed members.
- Encrypted channel tests reject tampering, replay, wrong connection/direction and queued-send backpressure. Generation checks prevent old sockets writing after remove/re-register.
- Custom host development smoke passed: WSS upgrade authentication/origin refusal, protocol-v2 challenge and Chromium Settings/mobile flow. The browser add request contains no `localUrl`.
- An isolated **production webpack build** passed outside the development worktree. Production launcher smoke passed a full encrypted WSS registration, checked the inbound record through the real management route, authentication and retired-HTTP refusal, and reran Chromium Settings. No running service was switched for this revision.
- TypeScript, ESLint and Diff checks passed.
- Full suite: **3,681 passed, 3 failed, 3 skipped** (3,687 total). The same three previously baselined environment failures remain; no new failing test was observed.

Key files: `lib/sync-socket.ts`, `lib/sync-channel.ts`, `lib/sync-transport-state.ts`, `bin/pi-web-server.js`. The upgrade path bypasses Next proxy execution and explicitly reuses its host/origin checks and shared Basic login throttle. Tests do not establish native Windows/macOS support, production reverse-proxy interoperability or high-load behavior. Snapshots still exchange approximately every 30 seconds, not on each filesystem write.

## Historical HTTP revision

Status: the Linux review and automated verification described below are complete. Plan step 8 is **not complete**: native Windows/macOS and production deployment checks remain outstanding. This is not a security certification.

## Scope and method

Reviewed the sync scope, metadata/key handling, crypto, bounded HTTP parsing, protocol/policies, locks/recovery, management/peer routes, scheduler integration, Settings UI and translations. Included new/untracked files, not only `git diff`. Defects were reproduced with regression tests, corrected, and retested. The last review pass after the registration rollback fix found no further medium/high-risk issue within this scope.

During that historical review, no production deployment, real agent-directory modification, service restart or `next build` was performed (the later HTTP deployment and isolated WSS production build are separate activities). Browser verification used a temporary dev instance, real browser login and a mocked sync API. HTTPS integration used throwaway directories, random passwords, real TLS sockets and the production proxy/route functions in separate processes; it did not run production Next servers or a reverse proxy.

## Reproduced defects and fixes

| Defect | Fix and regression coverage |
| --- | --- |
| Delayed authority snapshots could undo newer applied data, including partial merges | Persisted per-peer snapshot watermarks before file application; stale authority and partial-success tests |
| A failed later write lost version provenance for earlier successful writes | Bounded batch write-ahead journal; recovery adopts remote metadata only when actual bytes match; competing edits stay local |
| Merged content/serialized JSON could exceed transport limits after writing | Preflight the union, including path overhead; do not spend anticipated deletion/shrink savings |
| Malformed version flags, unknown fields and prototype-shaped paths | Strict version copying and path validation before object assignment; malformed local ledgers rejected |
| Windows reserved-name variants and excessive inbound tree depth | Portable path validation aligned with local scan limits |
| Lock heartbeat compromise could throw outside the operation; early release could retain old heartbeat/exit ownership | Catch compromise, check ownership before writes, always release library state without deleting a replacement lock |
| Shutdown during a per-file lock wait could still apply a remote write | Recheck runtime authorization immediately before file mutation |
| Stalled streamed bodies could wait indefinitely | Deadline and nonblocking cancellation, including a stream whose cancellation promise never resolves |
| Failed registration could remove a newer registration of the same ID | Compare-and-delete rollback tied to the exact encrypted credential generation |
| Refresh/mutation UI responses could race | Serialized mutations, request sequence guards and disabled controls during refresh; browser regression |

Regression cases are in `lib/sync-review.test.mjs`, alongside scope/config/crypto/protocol/API tests. The compromised-lock cleanup regression deliberately inspects the pinned proper-lockfile implementation's internal lease table; revisit that test when upgrading the library.

## Latest results

Environment: Linux, Node v26.13.1 (the package minimum Node version was not separately exercised).

| Check | Result |
| --- | --- |
| Sync + API + Settings + i18n/navigation focused suite | 51 passed |
| `node e2e/sync-https.mjs` | Passed, three processes |
| Chromium Settings, refresh race and mobile layout | Passed; sync API mocked |
| `node_modules/.bin/tsc --noEmit` | Passed |
| `npm run lint` | Passed |
| Changed-file LSP diagnostics | No diagnostics recorded |
| Diff and whitespace review, including untracked source | Passed |
| `npm test` | 3,679 passed, 3 failed, 3 skipped (3,685 total) |

The three full-suite failures also reproduced in an isolated, unchanged `HEAD` archive using the same npm-script environment:

- `lib/plugin-updates.test.mjs`: test package was requested from the public npm registry and returned 404 rather than using the test registry. A direct Node invocation passed; the npm-script environment reproduced the failure.
- `lib/rotate-preview-secrets.test.mjs`: the privileged test process could write a mode-0500 directory, contrary to the read-only-directory test assumption.
- `lib/web-auth.test.mjs`: the harness already provided `PI_WEB_PASSWORD`; passing `undefined` triggered the function's environment default, contrary to the test expectation.

These existing failures were not changed or hidden by the sync work. The full suite is not all green.

### HTTPS integration coverage

- Valid temporary CA explicitly trusted; an untrusted certificate is refused. TLS verification is never disabled.
- Existing Basic authentication, Host/Origin refusal and shared login throttle.
- Reciprocal encrypted registration, no membership/credential relay in A↔B↔C.
- Bidirectional content and deletion propagation through the intermediary.
- Authority policy propagation with conflict waiting; direct authority connection resolves the conflict.
- Opposite-direction concurrent exchanges followed by convergence.
- Disabled and removed peers refused; offline/restart catch-up.
- Initial scheduler pass and the next real 30-second scheduled pass.
- No plaintext test credentials/config tokens in captured peer request/response bodies or sync metadata.

## Remaining verification / operational risks

1. Native Windows and macOS: filesystem/ACL semantics, lock identity, rename behavior, junctions, Unicode and long paths. Linux path tests do not establish native compatibility.
2. Real multi-machine Next deployments: production reverse proxy, CA provisioning, body/time limits, network interruption, suspend/resume and clock skew. The HTTPS harness is not a substitute for this.
3. Large-scope/concurrent-client load and slow/network disks: bounded hashing, JSON and crypto still run synchronously; latency impact on chats has not been benchmarked.
4. Device-bound/rotating OAuth credentials may require per-device login despite copying `auth.json`.
5. Writes are atomic per file, not a multi-file transaction or guaranteed power-loss recovery. Locks coordinate cooperative writers, not adversarial filesystem replacement.
6. One process per agent directory is the supported deployment model; in-memory one-use exchange secrets are not shared across load-balanced workers.
7. Removing a node does not revoke its previously shared full Pi Web password. Remove both records and rotate passwords to revoke access.

See [node-sync.md](node-sync.md) for deployment, scope, backup and revocation instructions.
