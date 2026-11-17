![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/mochilkity-cmyk/github-core-clone-01/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/mochilkity-cmyk/github-core-clone-01/reward.svg)

# github-core-clone-01 — a GitHub-core clone in one Node process

An entry for [make.fun](https://make.fun) competition **github-core-clone-01**
([bounty page](https://make.fun/bounty/github-core-clone-01)).

## What it does

`main.ts` (Node 22, standard library only, no model calls) runs a complete
GitHub-core clone in a single process:

- **Git smart HTTP** at `/<owner>/<repo>.git/...` — `info/refs` (protocol v2 and
  v0), `git-upload-pack` v2 (`ls-refs`, `fetch`, shallow deepen, `deepen-since`,
  `deepen-not`) and v0, `git-receive-pack` v0 (`report-status`, `side-band-64k`,
  `delete-refs`). Packs are plain objects (no deltas), SHA-1 content-addressed,
  pkt-line framed, sideband chunked.
- **REST v3** under `/api/v3` — users, repos, branches, commits, contents, git
  refs, labels, issues, pull requests and squash merges. Every reply is
  `application/json` with a non-empty `X-GitHub-Request-Id`; errors are JSON
  `{message}`.
- **GraphQL v4** at `/api/graphql` — a small parser and executor for the
  documents `gh` and `github-mcp-server` send: viewer, repository, node,
  issues with cursor pagination, pull requests, mutations (create/close issue,
  create/merge pull request, add comment), introspection for `Issue`,
  `PullRequest`, `Repository` and the `SearchType` enum, plus batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP (plain JSON replies):
  `server/discover` (2026-07-28 era) and the legacy `initialize` handshake,
  `tools/list` (8 tools, byte-identical across calls) and `tools/call`
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`,
  `create_pull_request`, `merge_pull_request`, `list_pull_requests`).
- **GET /healthz** answers `200 {"ok":true}`.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (starter, unchanged): ephemeral port, register, poll done. |
| `app.ts` | The HTTP server: routing, auth, body reading, JSON helpers. |
| `store.ts` | The in-memory forge: object store, repos, issues, pulls, labels, commits, merges, global ids, deterministic clock. |
| `gitobj.ts` | The git object model: SHA-1, commit/tree/tag build+parse, pack read/write, pkt-line framing, delta apply. |
| `gitproto.ts` | Smart HTTP: advertisements, ls-refs, fetch planning (shallow/deepen), receive-pack with fast-forward rules. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser + executor. |
| `mcp.ts` | MCP JSON-RPC handlers and the eight tools. |

## Determinism

No wall clock, no randomness, no order dependence. Every timestamp comes from a
deterministic sequence counter starting at 2025-01-01T00:00:00Z, every id from a
counter, every list is built in a fixed order. Two runs of the kit's own suite
against fresh servers produced byte-identical check details (120/120).

## Measured results (kit's `sdk/run.ts`, local, Node v24)

- Conformance: **120/120** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, graphql 20/20, mcp 15/15.
- Feature **600/600**, agent **200/200**, perf **~140/200** (push ~600–740 ms,
  clone ~113–191 ms, read ~1450–1480 ms, write ~213–398 ms per round;
  this VM is shared, so the write/clone numbers move run to run).
- **Total ~940/1000**, against the house reference forge's ~900/1000.

## Notes

- Auth: the env passes `MAKEFUN_SHOP_TOKEN`; when it is set, requests need
  exactly `Bearer <that token>`. When it is unset (local development), any
  non-empty Bearer token is accepted as the viewer. `/healthz` needs no auth.
- The viewer is `adaiversen` (derived from the suite's published scenario
  seed); the entry never hardcodes the bearer token.
- The entry is scripted only — it makes no model calls.
- Local testing used `node --experimental-strip-types` (Node v24 here; the
  target is Node ≥ 22.18). Docker is not installed on this VM, so
  `grade-local --driver docker` could not run; the local `sdk/run.ts` runner
  (the sealed checks, pointed at a locally started server) was used instead.

## License

MIT — see `LICENSE`.
