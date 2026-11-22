# Pi Web node synchronization (WSS)

> Back up the agent directories first. Sync replaces whole files and propagates deletions; it is not a backup service or a JSON-key merge. Connect only machines you control and trust: synchronized extensions/configuration can execute code when subsequently loaded.

## Connect a node

1. Run the same **WSS-capable** Pi Web version on both machines with Node >=22.19.0 and a strong `PI_WEB_PASSWORD`.
2. The receiving node B needs an HTTPS/WSS address reachable from A, with a trusted certificate. Add its DNS name to `PI_WEB_ALLOWED_HOSTS`. LAN/VPN addresses work; no public Internet exposure is required.
3. On A, open **Settings → Sync → Add a node**. Enter B's HTTPS origin, display name and existing Pi Web password. There is **no local address field**.
4. A authenticates to B and opens an outbound WSS connection. B records an inbound member without A's URL or login credential. A's own Pi Web password is **not sent to B**.
5. Enable **Automatic two-way sync** on both nodes. Configuration travels both ways over A's connection; B never needs to connect back to A. Closing the browser does not stop synchronization: the Pi Web server process owns the socket.

```text
A (LAN/NAT, no inbound port) ── authenticated WSS ──▶ B (reachable HTTPS)
                            ◀── configuration ───▶
```

Only B needs a reachable TLS server endpoint. A still has its own Pi Web login enabled, but does not need a domain, inbound firewall rule, server certificate or port forwarding to participate as a client. Two mutually unreachable machines still need a VPN or a shared reachable peer; WebSocket does not perform NAT traversal.

A↔B↔C can relay configuration through B. Node membership and login credentials are never relayed. Under authority mode each member should have a direct connection to the authority (the TCP connection may be initiated by either side).

### Upgrading from HTTP snapshot sync

The old `/api/sync/peer` registration/snapshot endpoint returns **410**. There is no HTTP or reverse-password fallback. Upgrade both ends, remove old node records on both sides, then add the connection once from the machine that can reach the other. Existing file ledgers and node identity remain local. Old stored outbound records remain readable, but cannot resume a WSS connection until re-registered. Do not copy another machine's `sync.json` or `sync.key`.

The event/incremental wire protocol is **v3**. Both ends must support it; a v2 full-snapshot socket is refused rather than silently falling back. Existing WSS connection generations can resume after both ends are upgraded; re-registration is only needed for the old HTTP records.

Old versions shared full login passwords in both directions. Upgrading does not revoke a password already disclosed: rotate it if that earlier grant is no longer wanted.

## Deployment

Use `pi-web` / `npm start` for production, `npm run dev` for development. These now start a thin custom HTTP host in `bin/pi-web-server.js`: normal requests go to Next, and `/api/sync/socket` upgrades go to the synchronization handler. **Bare `next start`/`next dev` do not provide this upgrade endpoint.** Development retains Turbopack/HMR. The launcher still rotates preview secrets before production startup.

| Variable | Purpose |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Agent directory, default `~/.pi/agent` |
| `PI_WEB_PASSWORD` | Existing Pi Web login; required on each node |
| `PI_WEB_ALLOWED_HOSTS` | Exact hostnames accepted by the receiving server |
| `PI_WEB_DISABLE_SYNC=1` | Disable sync connections and scheduling; restart after changing environment |
| `NODE_EXTRA_CA_CERTS` | Optional PEM CA file for private certificates; must be trusted by the connecting Node process, not just the browser |

Keep Pi Web behind a trusted TLS reverse proxy. Example Nginx location (inside the HTTPS server block):

```nginx
location /api/sync/socket {
    proxy_pass http://127.0.0.1:30141;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    proxy_buffering off;
}
```

Do not log Authorization, cookies or bodies. Do not disable certificate verification. An internal CA must include the actual hostname/IP in the certificate. The server accepts ordinary WS on its HTTP backend for TLS termination; the **outbound client always uses WSS**, refuses redirects and checks certificates. Restrict direct backend access to trusted hosts/networks.

## Connection lifecycle and authentication

- Upgrade authentication uses the existing Basic login (`pi` username), shared login-failure throttle and Host/Origin rules. Browser cookies cannot authorize a sync socket. No separate account, pairing token or pairing key is introduced.
- The receiver sends an ephemeral X25519 challenge; HKDF-SHA-256 derives a connection key. AES-256-GCM encrypts registration and every subsequent application frame, binding direction, connection nonce and exact increasing sequence as AAD. Replayed, reordered or altered frames close the connection. The connection generation ID is a nonsecret record version, not an authentication credential.
- Only A stores B's login credential, encrypted under local `sync.key`. B stores A's identity and connection generation but no reverse credential/address. A can log into B with this full Pi Web password; B receives only a sync connection, not A's full login.
- Heartbeats run every five seconds; missed responses, invalid messages, binary frames, protocol-order violations or backpressure terminate the link. Handshake and exchange deadlines are bounded. At most 100 live/pending sockets and four simultaneous background connection attempts are allowed.
- Filesystem events trigger synchronization, with a **300 ms debounce** (a continuous event burst is flushed after at most two seconds). Each node shares one bounded per-directory watcher set across its connections; newly created/replaced directories are rediscovered and symlinks/excluded trees are not watched. Quiet links send only heartbeats, not a 30-second sync round.
- Each round exchanges a **complete version/hash index**, then only the bodies of new/changed files that can win the current conflict policy. Unchanged bodies are never resent; deletions carry tombstones only. This is file-level delta transfer, **not binary-block patches or JSON-key merge**. A changed file is sent whole.
- Initial connection, reconnect and a **five-minute safety audit** reconcile indexes and still send only missing/differing bodies. The audit catches missed filesystem events/watch limits. At most 2,048 directories are watched; excess trees rely on the audit. Local scans currently rehash the allowed scope for correctness; network transfer is incremental, not every local disk read.
- A dirty event during an exchange schedules another round; notifications coalesce and cannot interleave file transactions. If an omitted body is now needed because the peer edited after advertising its hash, the batch is refused before writes/watermark advancement and retries a fresh index (bounded retries, then reconnect backoff). A fingerprint excluding transport counters avoids metadata-write feedback loops.
- Failed outbound connections retry with capped exponential backoff and jitter. Reconnect uses the stored peer ID and generation, never re-registers an unknown/removed member. Offline edits and tombstones remain in the ledger until the next successful exchange.
- Both global sync and the member must be enabled before exchanging configuration. Settings changes trigger connection reconciliation; established connections also recheck authorization before each snapshot/write. Shutdown closes sockets and refuses writes still waiting for a file lock.
- Removing a node closes/refuses that sync relationship, but does **not** revoke a previously shared full web password. For full revocation remove both records and rotate the receiving server's password. A reconnect after removal requires explicit registration. If a registration reply is lost, the remote may retain an orphan record: remove it before retrying.

The inner encryption prevents passive body/frame logs from seeing credentials/configuration, but an actively malicious TLS terminator can replace the key exchange. TLS termination remains trusted; this is not independent endpoint pinning.

## Scope and limits

Relative to the configured global agent directory:

- `auth.json`, `settings.json`, `models.json`, `models-store.json`;
- regular files recursively under `extensions/`, `skills/`, `prompts/`, `themes/`.

Sessions, caches, dependency/install trees, git metadata, executables/native libraries, archives, locks, temporary files and backups are excluded. Excluded directory names include `node_modules`, `sessions`, `cache`, `caches`, `.cache`, `install`, `npm`, `git`, `.git`, `bin`, `dist`, `build`. `sync.json` and `sync.key` are local only. Project directories, `mcp.json`, browser preferences and runtime/session state are not copied. Empty directories and symlinks are not copied.

Limits: 8 MiB per file, 16 MiB decoded contents / 24 MiB JSON per snapshot, 36 MiB encrypted frame, 5,000 tracked paths including tombstones, 64 resource subdirectory levels, 20,000 scanned entries, 100 configured peers and 32 MiB metadata. Preflight both content and serialized merged size without spending space from a deletion/shrink that a concurrent edit could prevent. Invalid/incomplete reads are refused, not converted into deletions. Root configuration must be valid UTF-8 JSON objects.

## Conflict policies

- **Latest change (`mtime`)** assigns a monotonic server observation time and file revision when content changes. Received versions advance the logical clock. Ties use revision, source ID and content digest/deletion marker. Filesystem mtimes are metadata, not trusted conflict authority. This is last *observed* change, not proof of offline editing order. Keep clocks synchronized; timestamps over five minutes in the future are refused.
- **Authority node** wins conflicts for known files when directly participating. Unknown files can be imported. Two non-authority nodes preserve differing versions and wait; they never elect a substitute. Removing/disabling the authority retains the policy. Missing files are deletions only when previously tracked.

Policy timestamps/IDs propagate before file decisions. Persisted snapshot sequence/watermarks prevent delayed authority snapshots rolling back newer or partially applied batches. Retries use fresh snapshots. Tombstones are not garbage-collected. Restoring only an old `sync.json` can break sequence ordering; pause the group and reconnect a restored node under a new identity.

## Filesystem/runtime safety

Portable paths reject escapes, alternate data streams, Windows reserved names, trailing dots/spaces, case/Unicode aliases and links below the agent directory. Reads are bounded descriptor reads. Writes take the SDK's per-file lock, recheck content after waiting, then use a private temporary sibling and atomic rename. A bounded journal records only intended paths/version metadata; recovery compares actual bytes so partially applied remote files retain their provenance and different local edits remain local. Compromised locks fail the operation without an uncaught heartbeat exception or deleting a replacement lock.

POSIX files are private (`0600`), new directories `0700`; Windows uses the account ACL. Execution permissions are not copied. Restrict directory access to the service account. These are per-file atomic writes, not multi-file transactions, power-loss guarantees or kernel-level CAS against adversarial/uncooperative processes.

No active chats are reloaded/terminated and dependencies are not installed. Already loaded resources may need normal reload or an idle restart. Paths, commands and platform-specific JSON contents are not rewritten. Device-bound/rotating OAuth credentials may still need local login.

## Validation

```sh
node --experimental-strip-types --test lib/sync-*.test.mjs app/api/sync/route.test.mjs
node e2e/sync-wss.mjs
node_modules/.bin/tsc --noEmit
npm run lint
```

`e2e/sync-wss.mjs` uses temporary certificates, three isolated Node processes and real TLS sockets, not mock fetch. The browser test `e2e/sync-settings.mjs` uses real login but mocks `/api/sync` to avoid modifying real configuration. `docs/node-sync-validation.md` records validation evidence and outstanding checks.

Native Windows/macOS, real multi-machine reverse-proxy/CA deployments, suspend/resume, clock skew and heavy-load/slow-disk behavior still need deployment-specific testing. Synchronous hashing/JSON/crypto is bounded but its latency impact is not benchmarked. Use one Pi Web process per agent directory; long-lived channels are process-local. Never run `next build` in the active development worktree.
