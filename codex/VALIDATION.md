# Public Codex 0.3.2 validation

Actual environment: Windows / Node v24.19.0 / Python 3.12.10. Legal relative deliverables were already resolved from the registered outbox. This version rejects ambiguous Windows drive-relative and root-relative anchors before join, and adds one real CLI consumer regression. The 0.3.1 and 0.3.0 sections below stay as earlier evidence. They are not recounted as this run. Private adapter trials are separate and are not included here.

From the repository root:

```text
node --test codex/tests/public.test.mjs
node codex/tools/check-public.mjs
```

The public suite completed with **8 passed, 0 failed**, exit 0. The structure check then passed, exit 0: version 0.3.2, 11 Node syntax checks, 3 Python AST checks, three reception tools, explicit configuration, bundled runtime dependencies, and no literal machine user paths or session IDs. The new test launched the ledger CLI with an independent spawn working directory. Nested, non-ASCII, and spaced relative attachments were snapshotted from the registered outbox rather than a same-named file in that working directory. On this Windows run, same-drive drive-relative paths (`C:name`, `C:sub/file` using the fixture volume letter) and a forward-slash root-relative path were rejected and were not read as attachments. Parent paths, absolute paths, and directory deliverables were still rejected. A normal delivery was claimed and acknowledged to the original fixture owner. Existing sent and sending records, including an existing snapshot, were left byte-for-byte unchanged. The process-global working directory was not changed.

No provider, real notification, installation, App operation, or publication was part of this check. Local raw output stays outside this tree. Ubuntu, macOS, and other Windows layouts were not executed, so those platforms remain unverified. Passing this Windows fixture run does not prove marketplace install or Desktop loading.

The maintainer separately verified normal Codex CLI marketplace registration, installation reporting version 0.3.2, and MCP discovery in an isolated CODEX_HOME. The active user profile was unchanged. This confirms package registration and discovery, not real Desktop loading or provider execution.

## Preserved 0.3.1 evidence

# Public Codex 0.3.1 targeted validation

Actual environment: Windows / Node24.19.0 / Python3.12.10. Only the file-only public prelaunch contract changed; earlier 0.3.0 reception evidence below is reused, not recounted as new evidence.

```text
node --test --test-name-pattern='public prelaunch rejection' codex/tests/public.test.mjs
node codex/tools/check-public.mjs
```

The targeted public check passed (1 test, exit0): matching trusted-wrapper metadata becomes one labelled blocked launch-failure notification to the original owner; diagnostic content is not inlined; wrong owner/path/possibly-started declarations do not create READY; existing normal READY, partial report, permanent claim and retired registration are preserved; repeated scan/helper does not change sent/READY, and the same job's new attempt in a fresh outbox receives independently. No provider, actual notification, installation or App operation occurred. Local raw output remains excluded from publication.

This proves the explicit file contract and conversion, not a provider-specific launch adapter or the truth of an arbitrary wrapper assertion. Silent exit/timeout still needs proper executor/adapter terminal evidence or Lead handling. Minimum runtimes, other platforms, real Desktop/official tools and full App lifecycle remain unverified here.

The maintainer separately verified normal Codex CLI marketplace registration, plugin installation reporting version 0.3.1, and MCP discovery in an isolated CODEX_HOME. The active user profile was unchanged. This confirms package registration and discovery, not real Desktop loading or provider execution.

## Preserved 0.3.0 evidence

# Public Codex 0.3.0 validation

Actual local environment: Windows, Node v24.19.0, Python 3.12.10. This record covers only the independent public subtree. No installed production plugin, real mailbox, model/provider, real notification, App lifecycle or automation was operated by these checks.

From the repository root:

```text
npm --prefix codex/plugin test
node codex/tools/check-public.mjs
```

The public test suite completed with **6 passed, 0 failed**, exit 0. A final targeted configuration/Windows case-identity check also passed, exit 0. The structure check passed: 11 Node syntax checks, 3 Python AST checks, version 0.3.0, exactly three reception tools, explicit configuration, and no literal machine user paths/session UUIDs. Local raw test output is excluded from publication; this summary and the relative commands are the public evidence.

| Actual public check | Observed result |
| --- | --- |
| Configuration/identity | Missing fields refuse startup. Explicit config overrides the current-user default file; missing/default partial config fails closed. CODEX_HOME/HOME/USERPROFILE are isolated temporary directories. No pipe or actor means no scan; real metadata can bind a missing actor, with no target/model override. |
| Windows file identity | Demo/demo project opt-outs remain separate. Case-distinct registered projects have distinct lowercase delivery IDs and intact original registration records. Long adapter IDs use bounded filesystem keys; no report/prompt digests are calculated in the polling path. |
| CLI/Bot READY and original prompt | Both sources use the same READY/REPORT/outbox contract. Reports and deliverables are snapshotted. The sent prompt exactly equals the claimed central prompt, includes the automatic delivery label and original report, and goes to the original owner with actual actor metadata. notLoaded is exercised by the fake host. |
| Registration/path/claim/ack | Same registration is idempotent; different job/attempt cannot reuse the canonical outbox. Owner change is explicit, old registration remains immutable. Escaping deliverables and damaged single jobs remain errors while a good delivery is collectable. Permanent claim cannot be taken twice; exact-owner ack is idempotent after sent. |
| Continued reception/dedup | Later READY changes for a consumed attempt do not send again. A new attempt in a fresh outbox sends independently. The default ledger uses READY only: it does not synthesize completion or failed delivery from executor PID exit. |
| OS leader and scoped faults | Only the holder scans; a real lease child exit releases the OS lock and another instance takes over without deleting lock files. An active owner stays pending; two simulated hours produce one scoped fault, then notLoaded permits delivery. Three observations of one registered collector error produce one fault; invalid unregistered files do not invent a target. |
| Uncertain/history/reconnect | Send timeout preserves sending/intent and is not resent. Same-launch-pipe health read rejection prevents scan and respects the simulated 60-second rate limit. Correct actual actor verification resumes an independent delivery. Missing historical central data becomes visible uncertain/fault without blocking another ready item; fault attempts remain single. |
| Real test-process reconstruction | One test Node process exits17 after an exact receipt is durable and before ack. A new standard stdio server instance completes only ack; send count remains1. This is a test process with a fake host, not an App restart. Current-user dependency discovery accepts a valid fake installed manifest and rejects an outside-cache override. |

Tests create fresh OS temporary directories and verify the exact resolved target before recursive cleanup. There are no published mailbox snapshots, private test evidence, user IDs or official server copies. The installable plugin bundles the default ledger; the repository CLI is only an entry to that same module.

Not yet locally verified: Ubuntu/macOS runtime and OS locking, minimum Node22/Python3.10 runtimes, actual Desktop loading of the public plugin/default config, real official-tool/notLoaded notifications, original Lead continuation, eager/autostart behavior, or full App update/close/reopen/new-pipe recovery. The maintained test code is portable; passing Windows fake-host tests does not prove those environments. Marketplace registration/publication acceptance is handled separately by the repository maintainer.
