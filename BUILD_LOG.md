# BUILD_LOG — github-core-clone-01

## 2026-11-16 (WIB) — entry built and measured

- **Deadline:** Sat 21 Nov 2026 13:30 WIB (2026-11-21T06:30:00Z). $500 total,
  NOT escrowed. Prize gate: beat the house reference forge (~900/1000) with a
  strictly higher mean score over 3 final instances AND a 90% paired t-interval
  of the per-instance lead > 0.
- **Language:** Node/TypeScript (starter), erasable TS only (no enums, namespaces
  or parameter properties — verified: the grading pod runs `node main.ts` with
  type stripping). Standard library only, one process, no model calls, no paid
  keys, no internet, no git binary.

## Architecture

- `main.ts` — starter lifecycle, unchanged (listen(0), register, poll done).
- `app.ts` — HTTP server: routing, auth, body reading, JSON helpers, manual
  URL/query parsing (no `new URL` per request).
- `store.ts` — in-memory forge: content-addressed objects, repos, refs, issues,
  pulls, labels, comments, commits, merges, global ids. Deterministic clock:
  every timestamp is `2025-01-01T00:00:00Z + sequence seconds`; no `Date.now()`,
  no `Math.random()`. A `verified` set makes closure checks O(1) on a linear
  push chain; `isFastForward` has a parent fast path.
- `gitobj.ts` — git object model: SHA-1, commit/tree/tag build+parse, pack
  read/write (plain objects, no deltas), pkt-line framing, delta apply.
  (One bug fixed during the build: `parsePktLines` broke on flush/delim/end
  packets — the `length < 4` guard ran before the 0/1/2 handling — and a new
  `readPktSection` returns the offset past the terminating flush so a push's
  pack bytes can be found. `readPack` now inflates each entry once.)
- `gitproto.ts` — smart HTTP. v2 advertisement (`agent`, `ls-refs=unborn`,
  `fetch=shallow`, `object-format=sha1`); v0 advertisements with the service
  preamble and caps on the first ref line. ls-refs with prefix filtering,
  symref and peeled tags. Fetch planning: depth-limited inclusion, shallow
  boundaries, unshallow detection, ACK/NAK negotiation, shallow-aware held set
  (a have below an old shallow boundary does NOT imply its ancestry — this is
  what a deepen fetch must send). Receive-pack v0 with per-ref ok/ng reporting,
  `non-fast-forward` as the exact refusal reason, all pack objects stored even
  when a ref update is refused. A bounded fetch-response cache (16 entries):
  a fetch response is a pure function of the request plus the immutable,
  content-addressed object graph, so memoizing it is exact.
- `rest.ts` — REST v3 (users, repos, branches, commits, contents, git refs,
  labels, issues, pulls, merges). Every reply JSON + `X-GitHub-Request-Id`.
  Issues and PRs share one number counter per repo. A bounded cache of
  serialized single-issue bodies (keyed by issue version) for the read workload.
- `graphql.ts` — hand-written GraphQL parser (operations, fragments, variables,
  aliases, input objects, enums) + executor. Viewer, repository, node, issues
  with cursor pagination, pull requests, the five mutations, introspection for
  Issue/PullRequest/Repository and the SearchType enum, batching. Unknown fields
  return HTTP 200 with an `errors` array naming the field.
- `mcp.ts` — MCP JSON-RPC 2.0: `server/discover` (2026-07-28 era) + legacy
  `initialize`, `tools/list` (8 tools, built once and frozen, byte-identical),
  `tools/call` with argument synonyms (`owner`/`owner_login`/`org`,
  `repo`/`repository`, `full_name`, `pull_number`/`number`, …).

## What was tested (kit's `sdk/run.ts` — the sealed checks, local server)

Local harness: `node --experimental-strip-types serve.ts` on port 18080 with
`MAKEFUN_SHOP_TOKEN=test-token-123` (harness in `/tmp/github-core-test/`, not
part of the entry). Docker is not installed on this VM, so
`grade-local --driver docker` could not run; the local runner is the same
sealed checks pointed at a locally started server.

| Run | Fresh server | Conformance | Feature | Agent | Perf | Total |
| --- | --- | --- | --- | --- | --- | --- |
| run1 | yes | 84/120 | — | — | — | — |
| run2 | no (stale state) | 85/120 | — | — | — | — |
| run3 | no (stale state) | 113/120 | — | — | — | — |
| run4 | yes | **120/120** | 600 | 200 | 125 | **925** |
| run6 | yes, `--perf` | 120/120 | 600 | 200 | 125 | 925 |
| run7 | yes, `--perf` | 120/120 | 600 | 200 | 142 | **942** |
| run8 | yes, `--perf` | 120/120 | 600 | 200 | 140 | **940** |

Per-workload p50 (run7 / run8): push 597 / 735 ms (T_ref 1640.82),
clone 191 / 113 ms (T_ref 266.941), read 1479 / 1451 ms (T_ref 2759.715),
write 242 / 398 ms (T_ref 348.965). This VM has 1.5 shared CPUs, so the
write/clone numbers move run to run; the totals (940–942) are stable.

**Determinism:** run7 and run8 check details are byte-identical across all 120
checks (the details embed commit SHAs), from two independent fresh servers.

## Bugs found and fixed during testing

1. `app.ts` git routing indexed path segments wrong (`filter` removes the
   leading empty segment; the repo is at index 1, and the POST paths have only
   3 segments, not 4).
2. REST commit view returned the message with its trailing `\n`; GitHub strips
   it (`parsed.message.replace(/\n$/, '')`).
3. ls-refs emitted an `unborn refs/heads/main` line for an empty repo: the
   empty-clone check forbids any `refs/`-named line, and the GraphQL fixture
   reads an unborn line as a real ref at the zero oid and then fails reading
   its tree. Removed — the default branch is named by the v0 advertisement's
   symref capability instead.
4. Fetch pack subtraction used the full closure of the haves, which swallowed
   the parent a deepen-2 fetch must deliver. Now subtracts the shallow-aware
   held set.
5. `gitobj.ts` `parsePktLines` flush/delim/end bug (above) and double inflate
   in `readPack`.
6. A parameter property in `graphql.ts` (`constructor(private readonly …)`)
   is not erasable TS — it fails under `--experimental-strip-types`. Rewritten
   as a plain field.

## Open risks

- **The house baseline can be beaten on this VM (940–942 vs ~900), but the
  final grade runs on 3 fresh instances in the trial pod.** The lead is ~40
  points and comes from systematic speed (push fast path, fetch cache, read
  cache), not from luck in one run, but the pod's hardware and load will move
  the perf points; the 90% paired t-interval gate is about the lead across
  those 3 instances, which cannot be measured here.
- **Not tested here:** the sealed env's trial flow itself (`grade-local
  --driver docker` — no Docker on this VM), the transcript bundle, `check`
  and `submit` (blocked on the GitHub 401 — see below), and Node 22
  (this VM has Node v24.22.1; the code is erasable TS and typechecks clean
  under `tsc --strict` with Node 22's surface).
- **GitHub blocker (needs the user):** `github` MCP `get_me` still fails 401
  despite the OAuth connect; no repo can be created and no submission made
  until the user reconnects GitHub and selects repositories. The entry is
  ready for `git init` + repo creation + transcript bundle + `check` + `submit`
  once that clears.

## Files

`main.ts`, `app.ts`, `store.ts`, `gitobj.ts`, `gitproto.ts`, `rest.ts`,
`graphql.ts`, `mcp.ts`, `package.json`, `tsconfig.json`, `LICENSE` (MIT),
`README.md`, `.makefun/owner.json`, `BUILD_LOG.md` (this file). Total tree
~190 KiB — well under the 16 MiB limit, no file over 8 MiB.
